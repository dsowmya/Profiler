# React Perf Lens

A Chrome/Edge browser extension that surfaces React render counts, wasted
re-renders, and bundle hotspots **inline with the DOM** — with all heavy
analysis running in a **Web Worker** so the main thread is never blocked.

## Features

| Feature | Detail |
|---------|--------|
| **Render count badges** | Every React component gets a live badge overlaid at its DOM position showing `×N` renders |
| **Wasted render detection** | Components that re-render with identical props are flagged ⚠ in red |
| **Severity scoring** | Composite score (wasted count + absolute count + render frequency) drives badge colour intensity |
| **Bundle hotspots** | Scans `PerformanceResourceTiming` entries for large/chunked scripts |
| **Zero main-thread cost** | All bookkeeping (history, wasted %, frequency, severity) runs in a dedicated `Worker` |
| **DevTools panel** | Full sortable tables for Components, Wasted Renders, Bundles + a live Timeline canvas |
| **Popup** | Quick toggle + top-8 component summary |

## Architecture

```
Page world (injected.js)
  └─ hooks __REACT_DEVTOOLS_GLOBAL_HOOK__
  └─ walks Fiber tree on every commit (iterative DFS, no stack risk)
  └─ window.postMessage → content script

Content Script (content.js)          Web Worker (worker.js)
  ├─ injects injected.js              ├─ ANALYZE_COMMIT  → severity, wasted%, freq
  ├─ creates Worker                   ├─ ANALYZE_BUNDLES → size sort, hotspot flags
  ├─ relays fiber data to Worker      └─ UNMOUNT / CLEAR
  ├─ receives analysis results
  ├─ paints DOM overlay (rAF-gated)
  └─ chrome.runtime.sendMessage → background

Background (background.js)
  ├─ caches data per tab
  ├─ updates action badge (wasted count)
  └─ broadcasts to DevTools panel port

Popup (popup.html / popup.js)
  └─ toggle overlay, clear, summary table

DevTools Panel (panel.html / panel.js)
  ├─ long-lived port to background
  ├─ Components table (sortable, filterable)
  ├─ Wasted Renders table with fix hints
  ├─ Bundle Hotspots table
  └─ Timeline canvas (renders/s + wasted over time)
```

## Install (unpacked)

1. Open `chrome://extensions`  
2. Enable **Developer mode** (top-right toggle)  
3. Click **Load unpacked** → select the `react-perf-lens/` folder  
4. Navigate to any React app — the ⚛ badge appears in the toolbar

## Usage

- **Popup** → toggle the DOM overlay on/off; red badge = wasted renders found  
- **DevTools → React Perf Lens tab** → full profiler panel  
  - Click any column header to sort  
  - Use the search box to filter by component name or source file  
  - Tick *Only wasted* to focus on problem components  
  - The Timeline tab shows render rate and wasted renders over time  
- **Overlay colours**  
  - 🟢 Green  — normal render rate  
  - 🟡 Yellow — elevated (>5 renders)  
  - 🟠 Orange — high (>20 renders or severity ≥40)  
  - 🔴 Red    — wasted renders detected  

## How wasted render detection works

On every Fiber commit, `injected.js` takes a **shallow snapshot** of each
component's `memoizedProps` (functions → `"[Function]"`, React elements →
`"[ReactElement]"`).  If the snapshot is identical to the previous commit the
render is marked **wasted** and the counter incremented.  The Worker tracks
`wastedCount / renderCount` to produce the `wastedPct` shown in the table.

Fix hints in the Wasted Renders tab:
- **Function components** → `React.memo()`
- **Class components** → `PureComponent` or `shouldComponentUpdate`
