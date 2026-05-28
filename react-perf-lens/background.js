/**
 * background.js — MV3 service worker.
 *
 * Roles:
 *  - Caches the latest profiler data per tab (survives popup close)
 *  - Relays toggle / clear commands to the active tab's content script
 *  - Broadcasts live updates to connected DevTools panel ports
 *  - Updates the extension badge with wasted-render count
 */
'use strict';

// tabId → { components, wastedRenders, bundles }
const tabCache = new Map();

// DevTools panel ports: portName → Port
const panelPorts = new Map();

// ─── Tab lifecycle ────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(tabId => tabCache.delete(tabId));

// ─── Long-lived port connections (DevTools panel) ─────────────────────────────
chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith('rpl-panel')) return;

  panelPorts.set(port.name, port);

  port.onDisconnect.addListener(() => panelPorts.delete(port.name));

  // On first connect, send whatever we have cached
  port.onMessage.addListener(msg => {
    if (msg.type === 'PANEL_READY') {
      const data = tabCache.get(msg.tabId);
      if (data) port.postMessage({ type: 'PROFILER_DATA', data });
    }
  });
});

// ─── One-shot message handler ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {

  // ── Data arriving FROM content script ──────────────────────────────────
  if (msg.type === 'PROFILER_DATA' && sender.tab?.id) {
    const tabId  = sender.tab.id;
    const cached = tabCache.get(tabId) || {};

    if (msg.data.components?.length)    cached.components    = msg.data.components;
    if (msg.data.wastedRenders?.length) cached.wastedRenders = msg.data.wastedRenders;
    if (msg.data.bundles?.length)       cached.bundles       = msg.data.bundles;

    tabCache.set(tabId, cached);

    // Update badge: number of components with wasted renders
    const wastedCount = (cached.wastedRenders || []).length;
    updateBadge(tabId, wastedCount);

    // Broadcast to all open DevTools panels
    for (const port of panelPorts.values()) {
      try { port.postMessage({ type: 'PROFILER_DATA', data: cached }); } catch {}
    }

    reply({ ok: true });
    return;
  }

  // ── Popup / panel requesting cached data ───────────────────────────────
  if (msg.type === 'GET_TAB_DATA') {
    queryActiveTab(tab => {
      if (!tab) { reply({ data: null }); return; }
      reply({ data: tabCache.get(tab.id) || null, tabId: tab.id });
    });
    return true; // async
  }

  // ── Overlay toggle / clear — relay to content script ──────────────────
  if (msg.type === 'TOGGLE_OVERLAY' || msg.type === 'CLEAR_DATA') {
    queryActiveTab(tab => {
      if (!tab) { reply({ ok: false }); return; }
      chrome.tabs.sendMessage(tab.id, msg)
        .then(r  => reply(r))
        .catch(() => reply({ ok: false }));
    });
    return true; // async
  }

  // ── Direct content-script query from popup ─────────────────────────────
  if (msg.type === 'GET_DATA') {
    queryActiveTab(tab => {
      if (!tab) { reply({ ok: false }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_DATA' })
        .then(r  => reply(r))
        .catch(() => reply({ ok: false }));
    });
    return true;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function queryActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => cb(tabs[0] || null));
}

function updateBadge(tabId, count) {
  const text  = count > 0 ? String(Math.min(count, 99)) : '';
  const color = count > 0 ? '#e74c3c' : '#555';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}
