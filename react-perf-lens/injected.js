/**
 * injected.js — runs in the PAGE world (not isolated content-script world).
 * Hooks __REACT_DEVTOOLS_GLOBAL_HOOK__ before React loads, then walks the
 * Fiber tree on every commit and posts plain-object data to the content script.
 */
;(function ReactPerfLensInjected() {
  'use strict';

  const MSG = '__RPL__';          // message namespace
  const ORIGIN = location.origin || '*';

  // ─── Fiber tag constants (React 18 / 19 stable) ───────────────────────────
  const Tag = {
    FunctionComponent:  0,
    ClassComponent:     1,
    HostRoot:           3,
    HostComponent:      5,
    HostText:           6,
    ForwardRef:        11,
    MemoComponent:     14,
    SimpleMemo:        15,
    ContextProvider:   10,
    ContextConsumer:    9,
    SuspenseComponent: 13,
    LazyComponent:     16,
  };

  const USER_COMPONENT_TAGS = new Set([
    Tag.FunctionComponent,
    Tag.ClassComponent,
    Tag.MemoComponent,
    Tag.SimpleMemo,
    Tag.ForwardRef,
  ]);

  // ─── Identity map (WeakMap-based stable IDs) ──────────────────────────────
  const fiberIds = new WeakMap();
  let nextId = 1;
  function fiberId(fiber) {
    if (!fiberIds.has(fiber)) fiberIds.set(fiber, nextId++);
    return fiberIds.get(fiber);
  }

  // ─── Per-component render state ───────────────────────────────────────────
  const renderCounts  = new Map(); // id → count
  const prevPropsSnap = new Map(); // id → shallow-snapshot string
  const wastedCounts  = new Map(); // id → wasted count

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function getDisplayName(fiber) {
    const { type, tag } = fiber;
    if (!type) return null;
    if (typeof type === 'string') return null; // DOM host element – skip
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
    if (typeof type === 'object') {
      if (type.displayName) return type.displayName;
      const inner = type.render || type.type;
      if (inner) return inner.displayName || inner.name || 'Anonymous';
    }
    return null;
  }

  /**
   * Produce a shallow string snapshot of props for cheap equality.
   * Skips functions, ReactElements, and circular objects.
   */
  function propsKey(props) {
    if (!props) return '';
    try {
      let s = '';
      for (const k of Object.keys(props).sort()) {
        const v = props[k];
        if (typeof v === 'function') { s += `${k}:fn,`; continue; }
        if (v && typeof v === 'object' && v.$$typeof) { s += `${k}:el,`; continue; }
        s += `${k}:${JSON.stringify(v)},`;
      }
      return s;
    } catch {
      return Math.random().toString(); // force "changed" on error
    }
  }

  /**
   * Walk to the nearest host DOM node for a user component.
   * Returns null for invisible / portal / portalled roots.
   */
  function nearestDomNode(fiber) {
    let cur = fiber.child;
    while (cur) {
      if (cur.tag === Tag.HostComponent && cur.stateNode instanceof Element) {
        return cur.stateNode;
      }
      cur = cur.child;
    }
    return null;
  }

  function safeRect(fiber) {
    const node = nearestDomNode(fiber);
    if (!node) return null;
    try {
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }

  function sourceLabel(fiber) {
    if (!fiber._debugSource) return null;
    const file = (fiber._debugSource.fileName || '').split('/').pop().split('\\').pop();
    return `${file}:${fiber._debugSource.lineNumber}`;
  }

  // ─── Iterative DFS fiber walk ─────────────────────────────────────────────
  function walkTree(rootFiber) {
    const results = [];
    const stack = [rootFiber];

    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber) continue;

      // Continue at same level via sibling
      if (fiber.sibling) stack.push(fiber.sibling);
      // Descend
      if (fiber.child)   stack.push(fiber.child);

      if (!USER_COMPONENT_TAGS.has(fiber.tag)) continue;

      const name = getDisplayName(fiber);
      if (!name) continue;

      const id    = fiberId(fiber);
      const count = (renderCounts.get(id) || 0) + 1;
      renderCounts.set(id, count);

      const snap = propsKey(fiber.memoizedProps);
      const prev = prevPropsSnap.get(id);
      const wasted = prev !== undefined && prev === snap;
      prevPropsSnap.set(id, snap);

      if (wasted) wastedCounts.set(id, (wastedCounts.get(id) || 0) + 1);

      results.push({
        id,
        name,
        renderCount:  count,
        wastedCount:  wastedCounts.get(id) || 0,
        isWasted:     wasted,
        domRect:      safeRect(fiber),
        source:       sourceLabel(fiber),
        tag:          fiber.tag,
      });
    }

    return results;
  }

  // ─── Commit handler ───────────────────────────────────────────────────────
  let commitSeq = 0;

  function onCommit(root) {
    try {
      if (!root?.current) return;
      const components = walkTree(root.current);
      if (components.length === 0) return;

      window.postMessage({
        [MSG]: true,
        type: 'REACT_COMMIT',
        payload: {
          seq:        ++commitSeq,
          ts:         performance.now(),
          components,
        },
      }, ORIGIN);
    } catch (err) {
      // swallow – never crash the page
    }
  }

  // ─── Unmount cleanup ──────────────────────────────────────────────────────
  function onUnmount(fiber) {
    if (!USER_COMPONENT_TAGS.has(fiber.tag)) return;
    const id = fiberIds.get(fiber);
    if (id == null) return;
    renderCounts.delete(id);
    prevPropsSnap.delete(id);
    wastedCounts.delete(id);

    window.postMessage({ [MSG]: true, type: 'UNMOUNT', payload: { id } }, ORIGIN);
  }

  // ─── Hook installation ────────────────────────────────────────────────────
  function installHook() {
    const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;

    if (existing) {
      // Wrap an existing hook (e.g. React DevTools is also installed)
      const origCommit  = existing.onCommitFiberRoot;
      const origUnmount = existing.onCommitFiberUnmount;

      existing.onCommitFiberRoot = function(id, root, ...rest) {
        if (origCommit) origCommit.call(this, id, root, ...rest);
        onCommit(root);
      };
      existing.onCommitFiberUnmount = function(id, fiber) {
        if (origUnmount) origUnmount.call(this, id, fiber);
        onUnmount(fiber);
      };
      return;
    }

    // Create the hook from scratch (must happen before React loads)
    const hook = {
      supportsFiber: true,
      _renderers: {},
      renderers: new Map(),

      inject(renderer) {
        const rid = String(Object.keys(this._renderers).length + 1);
        this._renderers[rid] = renderer;
        this.renderers.set(rid, renderer);
        return rid;
      },

      onCommitFiberRoot(_rendererID, root) { onCommit(root); },
      onCommitFiberUnmount(_rendererID, fiber) { onUnmount(fiber); },
      onPostCommitFiberRoot() {},
      onScheduleRoot() {},
      onScheduleUpdate() {},
      setStrictMode() {},
      getCurrentFiber() { return null; },
      checkDCE() {},
    };

    try {
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
        value: hook,
        configurable: true,
        writable: true,
      });
    } catch {
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    }
  }

  installHook();

  window.postMessage({ [MSG]: true, type: 'HOOK_READY', payload: {} }, ORIGIN);
})();
