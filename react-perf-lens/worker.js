/**
 * worker.js — Analysis Web Worker.
 * All CPU-intensive bookkeeping happens here, off the main thread.
 *
 * Inbound messages  → { type, payload }
 * Outbound messages ← { type, data }
 */
'use strict';

// ─── Per-component history ────────────────────────────────────────────────────
// id → { name, renderCount, wastedCount, renders: [{seq, ts, isWasted}] }
const compHistory = new Map();
const HISTORY_CAP = 200;

// ─── Bundle records ───────────────────────────────────────────────────────────
// url → { name, url, size, duration, isLarge, isChunk }
const bundleMap = new Map();

// ─── Commit analysis ──────────────────────────────────────────────────────────
function analyzeCommit({ seq, ts, components }) {
  const analyzed = [];

  for (const comp of components) {
    let rec = compHistory.get(comp.id);
    if (!rec) {
      rec = { name: comp.name, renderCount: 0, wastedCount: 0, renders: [] };
      compHistory.set(comp.id, rec);
    }

    rec.name        = comp.name;
    rec.renderCount = comp.renderCount;
    rec.wastedCount = comp.wastedCount;
    rec.renders.push({ seq, ts, isWasted: comp.isWasted });
    if (rec.renders.length > HISTORY_CAP) rec.renders.shift();

    // Render frequency: renders per second over the last 60 renders
    const freq = renderFrequency(rec.renders);

    analyzed.push({
      id:           comp.id,
      name:         comp.name,
      renderCount:  comp.renderCount,
      wastedCount:  comp.wastedCount,
      wastedPct:    comp.renderCount > 0
                      ? Math.round((comp.wastedCount / comp.renderCount) * 100)
                      : 0,
      isWasted:     comp.isWasted,
      freq,          // renders/sec
      domRect:      comp.domRect,
      source:       comp.source,
      severity:     severity(comp, freq),
    });
  }

  // Sort by severity desc, then renderCount desc
  analyzed.sort((a, b) => b.severity - a.severity || b.renderCount - a.renderCount);

  const wastedRenders = analyzed
    .filter(c => c.wastedCount > 0)
    .sort((a, b) => b.wastedCount - a.wastedCount)
    .slice(0, 30);

  return { analyzed, wastedRenders };
}

function renderFrequency(renders) {
  if (renders.length < 2) return 0;
  const recent = renders.slice(-30);
  const span   = recent[recent.length - 1].ts - recent[0].ts; // ms
  if (span <= 0) return 0;
  return parseFloat(((recent.length - 1) / (span / 1000)).toFixed(2));
}

/**
 * Severity score (0–100) drives overlay colour intensity.
 *  - wasted renders contribute the most
 *  - high absolute render count adds weight
 *  - high frequency adds weight
 */
function severity(comp, freq) {
  const wastedScore = Math.min(comp.wastedCount * 3, 40);
  const countScore  = Math.min(comp.renderCount / 5, 30);
  const freqScore   = Math.min(freq * 5, 30);
  return Math.round(wastedScore + countScore + freqScore);
}

// ─── Bundle analysis ──────────────────────────────────────────────────────────
function analyzeBundles({ resources }) {
  for (const r of resources) {
    if (!r.name) continue;
    const name = r.name.split('/').pop().split('?')[0] || r.name;
    bundleMap.set(r.name, {
      url:       r.name,
      name,
      size:      r.size      || 0,
      duration:  r.duration  || 0,
      isLarge:   (r.size || 0) > 100_000,   // > 100 KB
      isChunk:   /chunk|bundle|vendor|main|app/i.test(name),
    });
  }

  return Array.from(bundleMap.values())
    .sort((a, b) => b.size - a.size)
    .slice(0, 25);
}

// ─── Message router ───────────────────────────────────────────────────────────
self.onmessage = function ({ data }) {
  const { type, payload } = data;

  switch (type) {
    case 'ANALYZE_COMMIT': {
      const { analyzed, wastedRenders } = analyzeCommit(payload);
      const bundles = Array.from(bundleMap.values())
        .sort((a, b) => b.size - a.size)
        .slice(0, 25);

      self.postMessage({
        type: 'ANALYSIS_RESULT',
        data: { components: analyzed, wastedRenders, bundles },
      });
      break;
    }

    case 'ANALYZE_BUNDLES': {
      const bundles = analyzeBundles(payload);
      self.postMessage({
        type: 'BUNDLE_RESULT',
        data: { bundles },
      });
      break;
    }

    case 'UNMOUNT': {
      compHistory.delete(payload.id);
      break;
    }

    case 'CLEAR': {
      compHistory.clear();
      bundleMap.clear();
      self.postMessage({ type: 'CLEARED', data: {} });
      break;
    }
  }
};
