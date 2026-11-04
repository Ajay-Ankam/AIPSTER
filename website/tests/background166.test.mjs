// BACKGROUND166 focused tests: decorative control-panel background.
// Runs with plain node:test (no dependencies):
//   node --test website/tests/background166.test.mjs
// Exercises the real website/public/app/background166.js in a stub DOM via
// node:vm, plus static contract checks on the shell hook and shipped bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..', 'public');
const jsPath = resolve(root, 'app', 'background166.js');
const cssPath = resolve(root, 'app', 'background166.css');
const shellPath = resolve(root, 'app', 'index.html');
const jsSource = await readFile(jsPath, 'utf8');
const cssSource = await readFile(cssPath, 'utf8');

function makeCtx(recorder) {
  return new Proxy({}, {
    get(t, p) {
      if (typeof p === 'symbol') return undefined;
      if (p === 'createRadialGradient') {
        return () => {
          recorder.calls.push('createRadialGradient');
          return { addColorStop() {} };
        };
      }
      return (...args) => { recorder.calls.push(String(p)); return undefined; };
    },
    set() { return true; }
  });
}

function makeHarness({ width = 1280, height = 800, dpr = 1, reduced = false, dark = false, search = '', nullCtx = false } = {}) {
  const recorder = { calls: [], raf: 0, rafQueue: [], cancelled: [], scheduled: 0 };
  const winListeners = new Map();
  const docListeners = new Map();
  const mediaObjects = new Map();
  const bodyChildren = [];
  const classAdded = [];
  const classRemoved = [];

  function media(query) {
    if (!mediaObjects.has(query)) {
      const m = {
        matches: query.includes('reduced') ? reduced : query.includes('dark') ? dark : false,
        media: query,
        listeners: [],
        addEventListener(t, fn) { if (t === 'change') this.listeners.push(fn); },
        removeEventListener(t, fn) { this.listeners = this.listeners.filter((f) => f !== fn); },
        addListener(fn) { this.listeners.push(fn); },
        removeListener(fn) { this.listeners = this.listeners.filter((f) => f !== fn); },
        fire() { for (const fn of [...this.listeners]) fn({ matches: this.matches, media: query }); }
      };
      mediaObjects.set(query, m);
    }
    return mediaObjects.get(query);
  }

  const body = {
    firstChild: null,
    children: bodyChildren,
    insertBefore(el, ref) {
      el.parentNode = body;
      const at = ref ? bodyChildren.indexOf(ref) : -1;
      if (at >= 0) bodyChildren.splice(at, 0, el);
      else bodyChildren.unshift(el);
      body.firstChild = bodyChildren[0] || null;
      return el;
    },
    removeChild(el) {
      const at = bodyChildren.indexOf(el);
      if (at >= 0) bodyChildren.splice(at, 1);
      el.parentNode = null;
      body.firstChild = bodyChildren[0] || null;
      return el;
    },
    classList: {
      add(c) { classAdded.push(c); },
      remove(c) { classRemoved.push(c); }
    }
  };

  function makeCanvas() {
    return {
      id: '',
      width: 0,
      height: 0,
      parentNode: null,
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getContext(kind) {
        if (nullCtx || kind !== '2d') return null;
        return makeCtx(recorder);
      }
    };
  }

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    body,
    documentElement: { clientWidth: width, clientHeight: height, appendChild() {} },
    getElementById(id) { return bodyChildren.find((el) => el.id === id) || null; },
    createElement(tag) {
      if (tag === 'canvas') return makeCanvas();
      throw new Error('unexpected element: ' + tag);
    },
    getElementsByTagName(tag) { return tag === 'body' ? [body] : []; },
    addEventListener(t, fn) {
      if (!docListeners.has(t)) docListeners.set(t, []);
      docListeners.get(t).push(fn);
    },
    removeEventListener(t, fn) {
      docListeners.set(t, (docListeners.get(t) || []).filter((f) => f !== fn));
    },
    fire(t) { for (const fn of [...(docListeners.get(t) || [])]) fn({}); }
  };

  const windowStub = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
    location: { search },
    matchMedia: media,
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(fn);
    },
    removeEventListener(t, fn) {
      winListeners.set(t, (winListeners.get(t) || []).filter((f) => f !== fn));
    },
    fire(t) { for (const fn of [...(winListeners.get(t) || [])]) fn({}); },
    requestAnimationFrame(cb) {
      recorder.scheduled++;
      recorder.rafQueue.push(cb);
      return ++recorder.raf;
    },
    cancelAnimationFrame(id) { recorder.cancelled.push(id); }
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    performance: { now: () => 0 },
    URLSearchParams,
    console
  };
  sandbox.globalThis = sandbox;
  runInNewContext(jsSource, sandbox, { filename: 'background166.js' });
  const api = sandbox.window.AipsterBackground166;
  assert.ok(api, 'script must expose window.AipsterBackground166');
  return { api, recorder, winListeners, docListeners, mediaObjects, bodyChildren, classAdded, classRemoved, windowStub, documentStub };
}

function drive(harness, n, stepMs = 16) {
  let ts = 1000;
  for (let i = 0; i < n; i++) {
    const cb = harness.recorder.rafQueue.pop();
    assert.ok(cb, `frame ${i} must be scheduled`);
    ts += stepMs;
    cb(ts);
  }
}

test('shell hook loads the approved entry plus exactly the namespaced background script', async () => {
  const shell = await readFile(shellPath, 'utf8');
  const scripts = [...shell.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['/app/app.js', '/app/background166.js']);
  assert.ok(shell.includes('<link rel="stylesheet" href="/app/background166.css">'), 'background stylesheet must be linked');
  assert.ok(!shell.includes('aipster-bg166'), 'canvas stays JS-injected, not hardcoded');
});

test('static gate allowlists exactly the two new background assets', async () => {
  const { publicFiles } = await import('../scripts/check.mjs');
  assert.ok(publicFiles.includes('app/background166.js'), 'JS must be allowlisted');
  assert.ok(publicFiles.includes('app/background166.css'), 'CSS must be allowlisted');
  assert.deepEqual([...publicFiles].sort(), publicFiles, 'allowlist stays sorted');
});

test('animated start schedules one frame chain and one canvas with bounded density', () => {
  const h = makeHarness({ width: 1280, height: 800, dpr: 2 });
  assert.equal(h.recorder.scheduled, 1, 'exactly one rAF chain after auto-start');
  assert.equal(h.bodyChildren.length, 1, 'exactly one canvas injected');
  assert.equal(h.bodyChildren[0].attrs['aria-hidden'], 'true', 'canvas must be decorative');
  const s = h.api.state();
  assert.equal(s.reduced, false);
  assert.ok(s.stars >= 24 && s.stars <= 120, `stars bounded (got ${s.stars})`);
  assert.ok(s.nodes >= 8 && s.nodes <= 30, `nodes bounded (got ${s.nodes})`);
  assert.ok(s.streams >= 0 && s.streams <= 8, `streams bounded (got ${s.streams})`);
  assert.ok(s.dpr <= 1.5, `pixel ratio capped (got ${s.dpr})`);
  drive(h, 5);
  const stats = h.api.stats();
  assert.equal(stats.frames, 5);
  assert.ok(typeof stats.avgFrameMs === 'number' && stats.avgFrameMs >= 0);
});

test('re-init while active reuses the single canvas and loop', () => {
  const h = makeHarness();
  const before = h.recorder.scheduled;
  h.api.init();
  h.api.init();
  assert.equal(h.recorder.scheduled, before, 'no extra frame chains on re-init');
  assert.equal(h.bodyChildren.length, 1, 'no extra canvas on re-init');
  assert.equal((h.winListeners.get('resize') || []).length, 1, 'one resize listener');
});

test('reduced motion at start renders a static frame with no scheduled frames', () => {
  const h = makeHarness({ reduced: true });
  assert.equal(h.recorder.scheduled, 0, 'no frames scheduled under reduced motion');
  const fills = h.recorder.calls.filter((c) => c === 'fill').length;
  assert.ok(fills > 0, 'one static composition must still be painted');
  assert.equal(h.api.state().reduced, true);
  assert.equal(h.api.state().running, false);
});

test('static query override forces the reduced path for fixture previews', () => {
  const h = makeHarness({ search: '?bg166=static' });
  assert.equal(h.recorder.scheduled, 0, 'override must suppress scheduling');
  assert.equal(h.api.state().reduced, true);
});

test('hidden document pauses the loop and visible resumes it on the same canvas', () => {
  const h = makeHarness();
  drive(h, 2);
  const canvas = h.bodyChildren[0];
  h.documentStub.hidden = true;
  h.documentStub.fire('visibilitychange');
  assert.ok(h.recorder.cancelled.length >= 1, 'hide must cancel the frame');
  assert.equal(h.api.state().running, false);
  const scheduledBefore = h.recorder.scheduled;
  h.documentStub.hidden = false;
  h.documentStub.fire('visibilitychange');
  assert.equal(h.recorder.scheduled, scheduledBefore + 1, 'show must resume with one chain');
  assert.equal(h.bodyChildren.length, 1, 'resume must not add a canvas');
  assert.equal(h.bodyChildren[0], canvas, 'resume must reuse the canvas');
  drive(h, 2);
  assert.equal(h.api.stats().frames, 4);
});

test('reduced-motion change at runtime stops scheduling and repaints static', () => {
  const h = makeHarness();
  drive(h, 2);
  const scheduledBefore = h.recorder.scheduled;
  const fillsBefore = h.recorder.calls.filter((c) => c === 'fill').length;
  const mq = h.mediaObjects.get('(prefers-reduced-motion: reduce)');
  mq.matches = true;
  mq.fire();
  assert.equal(h.api.state().reduced, true);
  assert.equal(h.recorder.scheduled, scheduledBefore, 'no new frames after reduce');
  const fillsAfter = h.recorder.calls.filter((c) => c === 'fill').length;
  assert.ok(fillsAfter > fillsBefore, 'must repaint one static composition');
});

test('resize rebuilds the field without extra canvases or loops', () => {
  const h = makeHarness({ width: 1280, height: 800 });
  drive(h, 1);
  h.windowStub.innerWidth = 900;
  h.windowStub.innerHeight = 1400;
  h.windowStub.fire('resize');
  const s = h.api.state();
  assert.equal(s.width, 900);
  assert.equal(s.height, 1400);
  assert.ok(s.nodes >= 8 && s.nodes <= 30);
  assert.equal(h.bodyChildren.length, 1, 'resize must not add a canvas');
});

test('narrow viewport uses the compact edge distance', () => {
  const h = makeHarness({ width: 390, height: 844, dpr: 2 });
  assert.equal(h.api.state().edgeDist, 130);
  const wide = makeHarness({ width: 1440, height: 900 });
  assert.equal(wide.api.state().edgeDist, 170);
});

test('destroy tears down canvas, loop and listeners; init restores them', () => {
  const h = makeHarness();
  drive(h, 1);
  h.api.destroy();
  assert.equal(h.api.state().active, false);
  assert.equal(h.bodyChildren.length, 0, 'canvas must be removed');
  assert.equal((h.winListeners.get('resize') || []).length, 0, 'resize listener removed');
  assert.equal((h.docListeners.get('visibilitychange') || []).length, 0, 'visibility listener removed');
  const scheduledBefore = h.recorder.scheduled;
  h.api.init();
  assert.equal(h.api.state().active, true);
  assert.equal(h.bodyChildren.length, 1, 're-init restores one canvas');
  assert.equal(h.recorder.scheduled, scheduledBefore + 1, 're-init schedules exactly one new chain');
});

test('missing 2d context falls back to static CSS without scheduling', () => {
  const h = makeHarness({ nullCtx: true });
  assert.equal(h.recorder.scheduled, 0, 'no frames without a context');
  assert.ok(h.classAdded.includes('aipster-bg166-static'), 'static fallback class must be set');
  assert.equal(h.api.state().active, true, 'inactive canvas must not break the panel');
});

test('shipped bytes carry no branding, tracking, network or pointer hooks', () => {
  const low = jsSource.toLowerCase();
  // 'pixel' is intentionally absent from this list: window.devicePixelRatio
  // is the required input to the DPR cap. Remote pixels are covered by the
  // tracking/beacon/URL entries instead.
  for (const banned of ['heurchain', 'analytics', 'tracking', 'beacon', 'posthog', 'fetch(', 'xmlhttprequest', 'websocket', 'localstorage', 'sessionstorage', 'document.cookie', 'mousemove', 'pointerdown', 'pointermove', 'click', 'keydown', 'http://', 'https://']) {
    assert.ok(!low.includes(banned), `background JS must not contain ${banned}`);
  }
  assert.ok(!/\.innerhtml\s*=/.test(jsSource), 'no HTML injection');
  assert.ok(cssSource.includes('pointer-events: none'), 'canvas must not intercept pointer input');
  assert.ok(cssSource.includes('z-index: -1'), 'canvas must sit behind content');
  assert.ok(!/url\s*\(/i.test(cssSource.replace(/\/\*[\s\S]*?\*\//g, '')), 'CSS must embed no remote content');
  assert.ok(!/https?:|data:|javascript:|\/\//i.test(cssSource), 'CSS must carry no URLs or comment slashes');
});
