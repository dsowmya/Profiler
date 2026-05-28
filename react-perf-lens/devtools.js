/**
 * devtools.js — Runs in the devtools_page context.
 * Creates the "React Perf Lens" panel in Chrome DevTools.
 */
chrome.devtools.panels.create(
  'React Perf Lens',
  null,           // no icon (use null for default)
  'panel.html',
  panel => {
    // panel is the ExtensionPanel — nothing extra needed here;
    // all logic lives in panel.js which loads inside panel.html
  }
);
