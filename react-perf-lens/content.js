/**
 * content.js — Content Script (isolated world, document_start).
 *
 * Responsibilities:
 *  1. Inject injected.js into the page world before React loads
 *  2. Receive REACT_COMMIT messages from injected.js via window.postMessage
 *  3. Forward to the analysis Web Worker
 *  4. Receive analysis results and render the DOM overlay
 *  5. Relay summary data to popup / DevTools panel via background
 */
;(function ReactPerfLensContent() {
  'use strict';

  const MSG        = '__RPL__';
  const OVERLAY_ID = '__rpl_root__';

  // ─── State ──────────────────────────────────────────────────────────────
  let worker           = null;
  let overlayEnabled   = false;
  let overlayRoot      = null;
  let rafPending       = false;

  // Latest data for GET_DATA requests
  let latestComponents  = [];
  let latestWasted      = [];
  let latestBundles     = [];

  // Per-component overlay elements
  const badges     = new Map(); // id → {badge, highlight}

  // ─── Inject page-world script ──────────────────────────────────────────
  function injectPageScript(url) {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => s.remove();
    (document.head || document.documentElement).prepend(s);
  }

  // ─── Web Worker bootstrap ──────────────────────────────────────────────
  function startWorker() {
    worker = new Worker(chrome.runtime.getURL('worker.js'));
    worker.onmessage = onWorkerMessage;
    worker.onerror   = e => console.warn('[RPL] worker error', e);
  }

  function onWorkerMessage({ data }) {
    const { type, data: payload } = data;

    if (type === 'ANALYSIS_RESULT') {
      latestComponents = payload.components || [];
      latestWasted     = payload.wastedRenders || [];
      latestBundles    = payload.bundles || [];

      if (overlayEnabled && !rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          renderOverlay(latestComponents);
        });
      }

      // Notify background (which forwards to popup / panel)
      chrome.runtime.sendMessage({
        type: 'PROFILER_DATA',
        data: { components: latestComponents, wastedRenders: latestWasted, bundles: latestBundles },
      }).catch(() => {});
    }

    if (type === 'BUNDLE_RESULT') {
      latestBundles = payload.bundles || [];
      chrome.runtime.sendMessage({
        type: 'PROFILER_DATA',
        data: { components: latestComponents, wastedRenders: latestWasted, bundles: latestBundles },
      }).catch(() => {});
    }

    if (type === 'CLEARED') {
      latestComponents = [];
      latestWasted     = [];
      latestBundles    = [];
      destroyOverlay();
    }
  }

  // ─── Listen to injected.js ─────────────────────────────────────────────
  let commitCounter = 0;
  window.addEventListener('message', evt => {
    if (evt.source !== window) return;
    if (!evt.data || !evt.data[MSG]) return;

    const { type, payload } = evt.data;

    if (type === 'REACT_COMMIT' && worker) {
      worker.postMessage({ type: 'ANALYZE_COMMIT', payload });

      // Sample resource performance every 10 commits
      if (++commitCounter % 10 === 1) {
        try {
          const resources = performance
            .getEntriesByType('resource')
            .filter(r => r.initiatorType === 'script')
            .map(r => ({
              name:     r.name,
              size:     r.transferSize || r.encodedBodySize || 0,
              duration: Math.round(r.duration),
            }));
          if (resources.length) {
            worker.postMessage({ type: 'ANALYZE_BUNDLES', payload: { resources } });
          }
        } catch {}
      }
    }

    if (type === 'UNMOUNT' && worker) {
      worker.postMessage({ type: 'UNMOUNT', payload });
    }
  });

  // ─── Chrome runtime messages (from popup / panel / background) ─────────
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg.type) {
      case 'TOGGLE_OVERLAY':
        overlayEnabled = !!msg.enabled;
        if (!overlayEnabled) destroyOverlay();
        else renderOverlay(latestComponents);
        reply({ ok: true });
        break;

      case 'GET_DATA':
        reply({
          ok:         true,
          overlayOn:  overlayEnabled,
          components: latestComponents,
          wastedRenders: latestWasted,
          bundles:    latestBundles,
        });
        break;

      case 'CLEAR_DATA':
        worker?.postMessage({ type: 'CLEAR' });
        destroyOverlay();
        reply({ ok: true });
        break;
    }
    return true; // keep channel open for async reply
  });

  // ─── Overlay rendering ─────────────────────────────────────────────────
  function ensureRoot() {
    if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
    overlayRoot = document.createElement('div');
    overlayRoot.id = OVERLAY_ID;
    overlayRoot.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:2147483647', 'overflow:hidden',
    ].join(';');
    document.documentElement.appendChild(overlayRoot);
    return overlayRoot;
  }

  function renderOverlay(components) {
    if (!overlayEnabled) return;
    const root   = ensureRoot();
    const seen   = new Set();

    for (const comp of components) {
      if (!comp.domRect) continue;
      seen.add(comp.id);

      let entry = badges.get(comp.id);
      if (!entry) {
        entry = {
          badge:     createBadge(),
          highlight: createHighlight(),
        };
        root.appendChild(entry.highlight);
        root.appendChild(entry.badge);
        badges.set(comp.id, entry);
      }

      positionEntry(entry, comp);
    }

    // Remove stale entries
    for (const [id, entry] of badges) {
      if (!seen.has(id)) {
        entry.badge.remove();
        entry.highlight.remove();
        badges.delete(id);
      }
    }
  }

  function createBadge() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'font:600 10px/1 monospace',
      'padding:2px 5px',
      'border-radius:3px 3px 3px 0',
      'color:#fff',
      'white-space:nowrap',
      'transition:background 0.2s',
      'z-index:2147483647',
    ].join(';');
    return el;
  }

  function createHighlight() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'box-sizing:border-box',
      'transition:border-color 0.15s,background 0.15s',
      'z-index:2147483646',
    ].join(';');
    return el;
  }

  function positionEntry({ badge, highlight }, comp) {
    const { left, top, width, height } = comp.domRect;
    const color = severityColor(comp);

    // Badge sits above the top-left corner
    badge.style.left       = `${left}px`;
    badge.style.top        = `${Math.max(0, top - 16)}px`;
    badge.style.background = color.bg;
    badge.textContent      = comp.isWasted
      ? `⚠ ${comp.name}  ×${comp.renderCount}`
      : `${comp.name}  ×${comp.renderCount}`;
    badge.title            = buildTooltip(comp);

    // Highlight border
    highlight.style.left        = `${left}px`;
    highlight.style.top         = `${top}px`;
    highlight.style.width       = `${width}px`;
    highlight.style.height      = `${height}px`;
    highlight.style.border      = `1px solid ${color.border}`;
    highlight.style.background  = color.fill;

    // Flash effect on fresh render
    if (comp.isWasted) {
      flash(highlight, '#ff444455', color.fill);
    }
  }

  function flash(el, from, to) {
    el.style.background = from;
    setTimeout(() => { if (el.isConnected) el.style.background = to; }, 250);
  }

  function severityColor(comp) {
    if (comp.isWasted || comp.wastedCount > 5) {
      return { bg: '#e74c3c', border: '#e74c3ccc', fill: '#e74c3c11' };
    }
    if (comp.severity >= 60 || comp.renderCount > 20) {
      return { bg: '#e67e22', border: '#e67e22cc', fill: '#e67e2211' };
    }
    if (comp.severity >= 30 || comp.renderCount > 5) {
      return { bg: '#f39c12', border: '#f39c12cc', fill: '#f39c1211' };
    }
    return { bg: '#27ae60', border: '#27ae60cc', fill: '#27ae6011' };
  }

  function buildTooltip(comp) {
    return [
      `Component : ${comp.name}`,
      `Renders   : ${comp.renderCount}`,
      comp.wastedCount ? `Wasted    : ${comp.wastedCount} (${comp.wastedPct}%)` : '',
      comp.freq        ? `Freq      : ${comp.freq} r/s` : '',
      comp.source      ? `Source    : ${comp.source}` : '',
      comp.isWasted    ? `\n⚠ Last render had identical props — wrap in React.memo?` : '',
    ].filter(Boolean).join('\n');
  }

  function destroyOverlay() {
    for (const { badge, highlight } of badges.values()) {
      badge.remove();
      highlight.remove();
    }
    badges.clear();
    overlayRoot?.remove();
    overlayRoot = null;
  }

  // ─── Boot ──────────────────────────────────────────────────────────────
  injectPageScript(chrome.runtime.getURL('injected.js'));
  startWorker();
})();
