/**
 * panel.js — DevTools Panel logic.
 *
 * Connects to the background service worker via a long-lived port so that
 * live PROFILER_DATA pushes update the panel without polling.
 */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let components    = [];
let wastedRenders = [];
let bundles       = [];

let paused        = false;
let overlayOn     = false;
let filterText    = '';
let onlyWasted    = false;

// Sort state per table
const sort = {
  components: { col: 'renderCount', asc: false },
  wasted:     { col: 'wastedCount', asc: false },
  bundles:    { col: 'size',        asc: false },
};

// Timeline ring buffer: [{seq, ts, count, wastedCount}]
const TIMELINE_CAP = 300;
const timeline     = [];

// ─── Tab ID resolution ────────────────────────────────────────────────────────
// Works in both DevTools-embedded mode and standalone tab mode
// (standalone: popup passes ?tabId=N in the URL)
function resolveTabId(cb) {
  if (typeof chrome.devtools !== 'undefined') {
    cb(chrome.devtools.inspectedWindow.tabId);
    return;
  }
  const fromUrl = new URLSearchParams(location.search).get('tabId');
  if (fromUrl) { cb(Number(fromUrl)); return; }
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => cb(tab?.id));
}

// ─── Background port ──────────────────────────────────────────────────────────
let tabId = null;
let port  = null;

resolveTabId(id => {
  tabId = id;
  initPort();

  // First paint from content script
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'GET_DATA' })
      .then(r => { if (r?.ok) ingestData(r); })
      .catch(() => {});
  }
});

function initPort() {
  port = chrome.runtime.connect({ name: `rpl-panel-${tabId}` });
  port.onMessage.addListener(({ type, data }) => {
    if (type === 'PROFILER_DATA' && !paused) ingestData(data);
  });
  port.onDisconnect.addListener(() => setTimeout(initPort, 2000));
  port.postMessage({ type: 'PANEL_READY', tabId });
}

// ─── Data ingestion ───────────────────────────────────────────────────────────
function ingestData(data) {
  if (data.components?.length)    components    = data.components;
  if (data.wastedRenders?.length) wastedRenders = data.wastedRenders;
  if (data.bundles?.length)       bundles       = data.bundles;

  // Push to timeline
  const totalRenders = components.reduce((s, c) => s + c.renderCount, 0);
  const wastedCount  = wastedRenders.length;
  timeline.push({ ts: Date.now(), totalRenders, wastedCount });
  if (timeline.length > TIMELINE_CAP) timeline.shift();

  renderAll();
}

// ─── Render all panels ────────────────────────────────────────────────────────
function renderAll() {
  updateStats();
  renderComponentsTable();
  renderWastedTable();
  renderBundlesTable();
  renderTimeline();
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
function updateStats() {
  const totalRenders = components.reduce((s, c) => s + c.renderCount, 0);
  const wCount       = wastedRenders.length;
  const maxFreq      = components.reduce((m, c) => Math.max(m, c.freq || 0), 0);
  const largestKB    = bundles[0] ? (bundles[0].size / 1024).toFixed(0) + ' KB' : '–';

  set('scComponents', components.length);
  set('scRenders',    totalRenders);
  set('scWasted',     wCount);
  set('scFreq',       maxFreq > 0 ? maxFreq + ' r/s' : '–');
  set('scBundleSize', largestKB);

  // Tab badges
  const wb = $('badgeWasted');
  if (wCount > 0) { wb.textContent = wCount; wb.style.display = ''; }
  else              wb.style.display = 'none';

  const cb = $('badgeComponents');
  const hotComponents = components.filter(c => c.severity >= 60).length;
  if (hotComponents > 0) { cb.textContent = hotComponents; cb.style.display = ''; }
  else                     cb.style.display = 'none';
}

// ─── Components table ─────────────────────────────────────────────────────────
function renderComponentsTable() {
  let rows = applyFilter(components);
  if (onlyWasted) rows = rows.filter(c => c.wastedCount > 0);
  rows = sortRows(rows, sort.components);

  const tbody = $('tbodyComponents');
  const empty = $('emptyComponents');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const maxRenders = rows[0]?.renderCount || 1;

  tbody.innerHTML = rows.map(c => {
    const sevColor = severityColor(c);
    const sevWidth = Math.max(2, Math.round((c.severity / 100) * 80));
    const pillCls  = c.wastedCount > 5 ? 'red' : c.renderCount > 20 ? 'orange' : 'green';

    return `<tr class="${c.wastedCount > 0 ? 'highlight' : ''}">
      <td title="${esc(c.name)}">${esc(c.name)}</td>
      <td>
        <span class="sev-bar" style="width:${Math.round((c.renderCount/maxRenders)*60)}px;background:${sevColor}"></span>
        <span class="pill ${pillCls}">${c.renderCount}</span>
      </td>
      <td>${c.wastedCount > 0 ? `<span class="pill red">⚠ ${c.wastedCount}</span>` : '–'}</td>
      <td>${c.wastedPct  > 0 ? `<span class="pill red">${c.wastedPct}%</span>` : '–'}</td>
      <td>${c.freq        > 0 ? `<span class="pill blue">${c.freq}</span>` : '–'}</td>
      <td>
        <span class="sev-bar" style="width:${sevWidth}px;background:${sevColor}"></span>
        ${c.severity}
      </td>
      <td class="src">${esc(c.source || '')}</td>
    </tr>`;
  }).join('');
}

// ─── Wasted renders table ─────────────────────────────────────────────────────
function renderWastedTable() {
  let rows = applyFilter(wastedRenders);
  rows = sortRows(rows, sort.wasted);

  const tbody = $('tbodyWasted');
  const empty = $('emptyWasted');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = rows.map(c => {
    const hint = fixHint(c);
    return `<tr>
      <td title="${esc(c.name)}">${esc(c.name)}</td>
      <td><span class="pill red">⚠ ${c.wastedCount}</span></td>
      <td><span class="pill orange">${c.wastedPct}%</span></td>
      <td>${c.renderCount}</td>
      <td class="src">${esc(c.source || '')}</td>
      <td style="color:#6b7280;font-size:10px;max-width:200px;white-space:normal">${hint}</td>
    </tr>`;
  }).join('');
}

// ─── Bundles table ────────────────────────────────────────────────────────────
function renderBundlesTable() {
  let rows = [...bundles];
  rows = sortRows(rows, sort.bundles);

  const tbody = $('tbodyBundles');
  const empty = $('emptyBundles');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const maxSize = rows[0]?.size || 1;

  tbody.innerHTML = rows.map(b => {
    const kb       = (b.size / 1024).toFixed(1);
    const barWidth = Math.max(2, Math.round((b.size / maxSize) * 100));
    const pillCls  = b.isLarge ? 'red' : b.size > 50_000 ? 'orange' : 'green';
    const hotspot  = b.isLarge
      ? '<span class="pill red">Large</span>'
      : b.isChunk
        ? '<span class="pill orange">Chunk</span>'
        : '<span class="pill gray">Normal</span>';

    return `<tr>
      <td title="${esc(b.url)}" style="max-width:260px">${esc(b.name)}</td>
      <td>
        <span class="size-bar" style="width:${barWidth}px"></span>
        <span class="pill ${pillCls}">${kb} KB</span>
      </td>
      <td>${b.duration > 0 ? b.duration + ' ms' : '–'}</td>
      <td>${hotspot}</td>
    </tr>`;
  }).join('');
}

// ─── Timeline canvas ──────────────────────────────────────────────────────────
function renderTimeline() {
  const canvas = $('timelineCanvas');
  const empty  = $('emptyTimeline');

  if (timeline.length < 2) {
    canvas.style.display = 'none';
    empty.style.display  = '';
    return;
  }
  empty.style.display  = 'none';
  canvas.style.display = 'block';

  const panel  = $('panelTimeline');
  const W      = panel.clientWidth  || 800;
  const H      = panel.clientHeight || 300;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const pad    = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top  - pad.bottom;

  const maxR = Math.max(...timeline.map(t => t.totalRenders), 1);
  const maxW = Math.max(...timeline.map(t => t.wastedCount),  1);
  const n    = timeline.length;

  function xPos(i) { return pad.left + (i / (n - 1)) * chartW; }
  function yRenders(v) { return pad.top + chartH - (v / maxR) * chartH; }
  function yWasted(v)  { return pad.top + chartH - (v / maxW) * chartH; }

  // Grid
  ctx.strokeStyle = '#1e2535';
  ctx.lineWidth   = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (g / 4) * chartH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + chartW, y); ctx.stroke();
  }

  // Total renders line (green)
  ctx.beginPath();
  ctx.strokeStyle = '#27ae60';
  ctx.lineWidth   = 1.5;
  timeline.forEach((t, i) => {
    const x = xPos(i), y = yRenders(t.totalRenders);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill under renders line
  ctx.beginPath();
  timeline.forEach((t, i) => {
    const x = xPos(i), y = yRenders(t.totalRenders);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(xPos(n - 1), pad.top + chartH);
  ctx.lineTo(xPos(0),     pad.top + chartH);
  ctx.closePath();
  ctx.fillStyle = '#27ae6018';
  ctx.fill();

  // Wasted renders line (red)
  ctx.beginPath();
  ctx.strokeStyle = '#e74c3c';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 3]);
  timeline.forEach((t, i) => {
    const x = xPos(i), y = yWasted(t.wastedCount);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  // Y-axis labels
  ctx.fillStyle  = '#6b7280';
  ctx.font       = '10px monospace';
  ctx.textAlign  = 'right';
  for (let g = 0; g <= 4; g++) {
    const v = Math.round((maxR * (4 - g)) / 4);
    const y = pad.top + (g / 4) * chartH;
    ctx.fillText(v, pad.left - 6, y + 3);
  }

  // Legend
  ctx.textAlign  = 'left';
  ctx.fillStyle  = '#27ae60';
  ctx.fillRect(pad.left, 4, 12, 3);
  ctx.fillStyle = '#dde1ec';
  ctx.fillText('Total renders', pad.left + 16, 10);

  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(pad.left + 120, 4, 12, 3);
  ctx.fillStyle = '#dde1ec';
  ctx.fillText('Wasted', pad.left + 136, 10);
}

// ─── Table sorting ────────────────────────────────────────────────────────────
function sortRows(rows, state) {
  return [...rows].sort((a, b) => {
    const av = a[state.col] ?? 0;
    const bv = b[state.col] ?? 0;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : bv - av;
    return state.asc ? -cmp : cmp;
  });
}

function bindTableSort(tableId, stateKey) {
  const table = $(tableId);
  if (!table) return;
  table.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const s   = sort[stateKey];
      if (s.col === col) s.asc = !s.asc;
      else { s.col = col; s.asc = false; }

      table.querySelectorAll('th').forEach(h => {
        h.classList.remove('sorted', 'asc');
      });
      th.classList.add('sorted');
      if (s.asc) th.classList.add('asc');

      renderAll();
    });
  });
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'panel' + capitalise(tab.dataset.tab);
      const panel   = $(panelId);
      if (panel) {
        panel.classList.add('active');
        if (tab.dataset.tab === 'timeline') renderTimeline();
      }
    });
  });
}

// ─── Toolbar controls ─────────────────────────────────────────────────────────
function bindToolbar() {
  $('btnOverlay').addEventListener('click', () => {
    overlayOn = !overlayOn;
    $('btnOverlay').textContent = overlayOn ? 'Hide Overlay' : 'Show Overlay';
    $('btnOverlay').classList.toggle('off', overlayOn);
    chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY', enabled: overlayOn }).catch(() => {});
  });

  $('btnClear').addEventListener('click', () => {
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR_DATA' }).catch(() => {});
    components    = [];
    wastedRenders = [];
    bundles       = [];
    timeline.length = 0;
    renderAll();
  });

  $('btnPause').addEventListener('click', () => {
    paused = !paused;
    $('btnPause').textContent = paused ? 'Resume' : 'Pause';
    $('btnPause').style.color = paused ? '#e67e22' : '';
  });

  $('tbSearch').addEventListener('input', e => {
    filterText = e.target.value.trim().toLowerCase();
    renderAll();
  });

  $('chkOnlyWasted').addEventListener('change', e => {
    onlyWasted = e.target.checked;
    renderAll();
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function applyFilter(rows) {
  if (!filterText) return rows;
  return rows.filter(r =>
    (r.name   || '').toLowerCase().includes(filterText) ||
    (r.source || '').toLowerCase().includes(filterText)
  );
}

function severityColor(c) {
  if (c.severity >= 70 || c.wastedCount > 5) return '#e74c3c';
  if (c.severity >= 40 || c.renderCount > 15) return '#e67e22';
  if (c.severity >= 20) return '#f1c40f';
  return '#27ae60';
}

function fixHint(c) {
  if (c.tag === 0 || c.tag === 15) return 'Wrap in <code>React.memo()</code> to skip re-renders with unchanged props.';
  if (c.tag === 1) return 'Extend <code>PureComponent</code> or implement <code>shouldComponentUpdate</code>.';
  return 'Check parent renders and consider memoization.';
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function $(id) { return document.getElementById(id); }
function set(id, v) { const el = $(id); if (el) el.textContent = v; }

// ─── Boot ─────────────────────────────────────────────────────────────────────
bindTabs();
bindToolbar();
bindTableSort('tblComponents', 'components');
bindTableSort('tblWasted',     'wasted');
bindTableSort('tblBundles',    'bundles');
renderAll();
