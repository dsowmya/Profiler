/**
 * popup.js — Extension popup logic.
 * Fetches latest profiler data from background cache and the live content script.
 */
'use strict';

const $ = id => document.getElementById(id);

let overlayOn = false;
let currentTabId = null;

// ─── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  bindControls();
  // Poll for updates every 1.5 s while popup is open
  setInterval(loadState, 1500);
});

// ─── Load data ─────────────────────────────────────────────────────────────────
async function loadState() {
  try {
    // Ask content script directly for the freshest data
    const live = await sendToContent({ type: 'GET_DATA' });
    if (live?.ok) {
      overlayOn      = !!live.overlayOn;
      currentTabId   = null; // content script replied, tab is active
      render(live);
      syncToggleBtn();
      return;
    }
  } catch {}

  // Fallback: use background cache
  try {
    const cached = await chrome.runtime.sendMessage({ type: 'GET_TAB_DATA' });
    if (cached?.data) {
      render(cached.data);
      currentTabId = cached.tabId;
    } else {
      showNoReact();
    }
  } catch {
    showNoReact();
  }
}

// ─── Render ────────────────────────────────────────────────────────────────────
function render({ components = [], wastedRenders = [], bundles = [] }) {
  if (!components.length && !wastedRenders.length) {
    showNoReact();
    return;
  }

  $('noReact').style.display    = 'none';
  $('appContent').style.display = '';

  const totalRenders = components.reduce((s, c) => s + c.renderCount, 0);
  const wastedCount  = wastedRenders.length;

  $('statComponents').textContent = components.length;
  $('statComponents').className   = 'val';

  $('statRenders').textContent = totalRenders;
  $('statRenders').className   = totalRenders > 200 ? 'val caution' : 'val';

  $('statWasted').textContent = wastedCount;
  $('statWasted').className   = wastedCount > 0 ? 'val warn' : 'val';

  // Top 8 components
  const top = [...components].slice(0, 8);
  const tbody = $('componentTable');
  tbody.innerHTML = top.map(c => {
    const pillClass = c.wastedCount > 0 ? 'red' : c.renderCount > 20 ? 'orange' : 'green';
    const wastedTag = c.wastedCount > 0
      ? `<span class="wasted-tag">⚠${c.wastedCount}</span>`
      : '';
    return `
      <tr title="${escHtml(buildTooltip(c))}">
        <td>${escHtml(c.name)}${wastedTag}</td>
        <td><span class="pill ${pillClass}">${c.renderCount}</span></td>
        <td>${c.wastedPct > 0 ? `<span class="pill red">${c.wastedPct}%</span>` : '–'}</td>
      </tr>`;
  }).join('');

  $('footerStatus').textContent = `${components.length} components tracked`;
}

function showNoReact() {
  $('noReact').style.display    = '';
  $('appContent').style.display = 'none';
  $('footerStatus').textContent = 'No React detected';
}

// ─── Controls ──────────────────────────────────────────────────────────────────
function bindControls() {
  $('btnToggle').addEventListener('click', async () => {
    overlayOn = !overlayOn;
    syncToggleBtn();
    await sendCommand({ type: 'TOGGLE_OVERLAY', enabled: overlayOn });
  });

  $('btnClear').addEventListener('click', async () => {
    await sendCommand({ type: 'CLEAR_DATA' });
    render({ components: [], wastedRenders: [], bundles: [] });
  });

  $('btnOpen').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const tabId = tab?.id ?? '';
      const url   = chrome.runtime.getURL(`panel.html?tabId=${tabId}`);
      chrome.tabs.create({ url });
      window.close();
    });
  });
}

function syncToggleBtn() {
  const btn = $('btnToggle');
  if (overlayOn) {
    btn.textContent = 'Hide Overlay';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Show Overlay';
    btn.classList.remove('active');
  }
}

// ─── Messaging helpers ─────────────────────────────────────────────────────────
function sendToContent(msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return reject(new Error('no tab'));
      chrome.tabs.sendMessage(tab.id, msg)
        .then(resolve)
        .catch(reject);
    });
  });
}

function sendCommand(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildTooltip(c) {
  return [
    `Renders: ${c.renderCount}`,
    c.wastedCount ? `Wasted: ${c.wastedCount} (${c.wastedPct}%)` : '',
    c.freq        ? `Freq: ${c.freq} r/s` : '',
    c.source      ? `Source: ${c.source}` : '',
  ].filter(Boolean).join('\n');
}
