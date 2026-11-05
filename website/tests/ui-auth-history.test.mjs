// Issue #106: /app session bootstrap never flashes sign-in for a signed-in
// caller, separates signed-out / rejected / transport-error outcomes, and
// tabs are browser-history entries. Minimal DOM + the exact checked-in client
// (same fixture style as ui-session.test.mjs); session responses are stubbed
// so delays and failures are deterministic. No real accounts or credentials.
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(here, '..', 'public', 'app', 'app.js');
const INDEX = path.resolve(here, '..', 'public', 'app', 'index.html');
const USER = { id: 'u_fixture', name: 'Fixture Owner', email: 'owner@aipster.invalid', username: 'owner' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function makeUi({ session, hash = '', search = '' }) {
  const source = await readFile(APP_JS, 'utf8');
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: false, textContent: '', innerHTML: '', value: '', attrs: {}, listeners: {}, dataset: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute(name, value) { this.attrs[name] = value; },
        querySelectorAll() { return []; }
      });
    }
    return elements.get(id);
  }
  // Initial shell mirrors public/app/index.html after the fix.
  const names = ['overview', 'compute', 'shared', 'sharing', 'models', 'federation', 'keys', 'usage', 'advice', 'settings'];
  const tabs = names.map((name) => { const e = el('nav-' + name); e.dataset.tab = name; e.attrs['aria-selected'] = name === 'overview' ? 'true' : 'false'; return e; });
  names.forEach((name) => { el('tab-' + name).hidden = name !== 'overview'; });
  for (const id of ['view-app', 'sessionbar', 'view-login', 'auth-retry', 'login-error']) el(id).hidden = true;
  el('view-auth').hidden = false;

  const calls = [];
  const sessionQueue = Array.isArray(session) ? [...session] : null;
  const fetchImpl = async (p, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${p}`);
    if (p === '/api/auth/get-session') return (sessionQueue ? sessionQueue.shift() : session)();
    if (p === '/api/auth/sign-out') return json({ success: true });
    return json({ error: 'stub' }, 503); // loaders render their own error state
  };
  const loc = { origin: 'http://localhost:8787', pathname: '/app/', search, hash };
  const listeners = {};
  const entries = [{ hash }];
  let index = 0;
  const setUrl = (url) => { const i = url.indexOf('#'); return { hash: i < 0 ? '' : url.slice(i) }; };
  const history = {
    pushState(_s, _t, url) { entries.splice(index + 1); entries.push(setUrl(url)); index++; loc.hash = entries[index].hash; },
    replaceState(_s, _t, url) { entries[index] = setUrl(url); loc.hash = entries[index].hash; },
  };
  const go = async (delta) => { index += delta; loc.hash = entries[index].hash; listeners.popstate?.(); await flush(); };
  const context = vm.createContext({
    document: { getElementById: el, querySelectorAll(sel) { return sel === '[data-tab]' ? tabs : sel === '[role="tabpanel"]' ? names.map((n) => el('tab-' + n)) : []; } },
    location: loc, fetch: fetchImpl, setTimeout() { return 0; }, clearTimeout() {}, console, URLSearchParams, history,
    addEventListener(type, fn) { listeners[type] = fn; },
  });
  // Not awaited: the script's completion value is the boot promise, which a
  // held session response deliberately keeps pending.
  new vm.Script(source, { filename: 'exact-client.js' }).runInContext(context);
  async function flush() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }
  const clickTab = async (name) => { tabs.find((e) => e.dataset.tab === name).listeners.click(); await flush(); };
  const selected = () => tabs.filter((e) => e.attrs['aria-selected'] === 'true').map((e) => e.dataset.tab);
  const visiblePanels = () => names.filter((n) => !el('tab-' + n).hidden);
  return { el, calls, flush, clickTab, selected, visiblePanels, go, loc, entries };
}

test('shell markup hides sign-in until the session check answers', async () => {
  const html = await readFile(INDEX, 'utf8');
  assert.match(html, /<section id="view-auth"[^>]*>/);
  assert.doesNotMatch(html.match(/<section id="view-auth"[^>]*>/)[0], /hidden/);
  assert.match(html.match(/<section id="view-login"[^>]*>/)[0], /\shidden[\s>]/);
  assert.match(html.match(/<div id="view-app"[^>]*>/)[0], /\shidden[\s>]/);
});

test('delayed session for a signed-in caller never shows sign-in, then shows the app', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const ui = await makeUi({ session: () => held.then(() => json({ user: USER, session: { id: 's' } })) });
  await ui.flush();
  assert.equal(ui.el('view-login').hidden, true, 'no sign-in flash while the session loads');
  assert.equal(ui.el('view-app').hidden, true, 'no protected panel before verification');
  assert.equal(ui.el('view-auth').hidden, false);
  assert.match(ui.el('auth-status').textContent, /Checking your session/);
  release();
  await ui.flush();
  assert.equal(ui.el('view-login').hidden, true);
  assert.equal(ui.el('view-auth').hidden, true);
  assert.equal(ui.el('view-app').hidden, false);
  assert.equal(ui.el('sessionbar').hidden, false);
});

for (const [label, res] of [
  ['no session (null)', () => json(null)],
  ['expired session (200, no user)', () => json({ session: null, user: null })],
  ['rejected session (401)', () => json({ error: 'Unauthorized' }, 401)],
]) {
  test(`confirmed signed-out path shows sign-in: ${label}`, async () => {
    const ui = await makeUi({ session: res });
    await ui.flush();
    assert.equal(ui.el('view-login').hidden, false);
    assert.equal(ui.el('view-auth').hidden, true);
    assert.equal(ui.el('view-app').hidden, true);
    assert.equal(ui.el('sessionbar').hidden, true);
  });
}

for (const [label, res] of [
  ['network failure', () => { throw new TypeError('Failed to fetch'); }],
  ['server error (503)', () => json({ error: 'down' }, 503)],
  ['non-JSON 200', () => new Response('<html>edge</html>', { status: 200 })],
]) {
  test(`session check failure is reported truthfully and retry recovers: ${label}`, async () => {
    const ui = await makeUi({ session: [res, () => json({ user: USER })] });
    await ui.flush();
    assert.equal(ui.el('view-login').hidden, true, 'an unknown outcome is not presented as signed out');
    assert.equal(ui.el('view-app').hidden, true, 'nor as signed in');
    assert.equal(ui.el('view-auth').hidden, false);
    assert.equal(ui.el('auth-retry').hidden, false, 'no permanent spinner: a retry is offered');
    assert.match(ui.el('auth-status').textContent, /Could not reach AIPSTER/);
    ui.el('auth-retry').listeners.click();
    await ui.flush();
    assert.equal(ui.el('view-app').hidden, false);
    assert.equal(ui.el('view-auth').hidden, true);
  });
}

test('tabs push history entries; back/forward restore the right tab', async () => {
  const ui = await makeUi({ session: () => json({ user: USER }), search: '?ref=x' });
  await ui.flush();
  assert.deepEqual(ui.selected(), ['overview']);
  await ui.clickTab('compute');
  assert.equal(ui.loc.hash, '#compute');
  await ui.clickTab('models');
  assert.equal(ui.loc.hash, '#models');
  assert.equal(ui.entries.length, 3);
  await ui.go(-1);
  assert.deepEqual(ui.selected(), ['compute']);
  assert.deepEqual(ui.visiblePanels(), ['compute']);
  await ui.go(-1);
  assert.deepEqual(ui.selected(), ['overview'], 'back walks toward Overview');
  assert.deepEqual(ui.visiblePanels(), ['overview']);
  await ui.go(+2);
  assert.deepEqual(ui.selected(), ['models']);
  // Re-clicking the current tab does not stack duplicate entries.
  await ui.clickTab('models');
  assert.equal(ui.entries.length, 3);
});

test('a tab deep link opens that tab after sign-in; unknown fragments fall back to Overview', async () => {
  const ui = await makeUi({ session: () => json({ user: USER }), hash: '#keys' });
  await ui.flush();
  assert.deepEqual(ui.selected(), ['keys']);
  assert.deepEqual(ui.visiblePanels(), ['keys']);
  const skip = await makeUi({ session: () => json({ user: USER }), hash: '#main' });
  await skip.flush();
  assert.deepEqual(skip.selected(), ['overview']);
});

test('a non-tab fragment (#main skip link) never switches tabs or clears tab state', async () => {
  const ui = await makeUi({ session: () => json({ user: USER }) });
  await ui.flush();
  await ui.clickTab('compute');
  assert.deepEqual(ui.selected(), ['compute']);
  const loadsBefore = ui.calls.length;
  // Skip to content: the browser navigates to #main and fires hashchange
  // (and popstate) without any tab click.
  ui.entries.push({ hash: '#main' });
  await ui.go(+1);
  assert.equal(ui.loc.hash, '#main');
  assert.deepEqual(ui.selected(), ['compute'], 'Compute stays selected');
  assert.deepEqual(ui.visiblePanels(), ['compute']);
  assert.equal(ui.calls.length, loadsBefore, 'no tab reload, so in-progress tab state is kept');
  // Back from #main to #compute is still a no-op; back again reaches Overview.
  await ui.go(-1);
  assert.deepEqual(ui.selected(), ['compute']);
  await ui.go(-1);
  assert.deepEqual(ui.selected(), ['overview']);
});

test('signed-out documents ignore history navigation; logout leaves no stale UI or loop', async () => {
  const ui = await makeUi({ session: () => json(null), hash: '#compute' });
  await ui.flush();
  await ui.go(0);
  assert.equal(ui.el('view-app').hidden, true, 'popstate never reveals protected panels while signed out');
  assert.equal(ui.calls.filter((c) => c === 'GET /api/auth/get-session').length, 1, 'no repeated session polling');

  const signedIn = await makeUi({ session: () => json({ user: USER }) });
  await signedIn.flush();
  await signedIn.clickTab('settings');
  await signedIn.el('logout').listeners.click();
  await signedIn.flush();
  assert.equal(signedIn.el('view-app').hidden, true);
  assert.equal(signedIn.el('view-login').hidden, false);
  assert.equal(signedIn.el('whoami').textContent, '');
  assert.equal(signedIn.loc.hash, '', 'tab fragment dropped on sign-out');
  await signedIn.go(-1); // back to a protected-tab entry after sign-out
  assert.equal(signedIn.el('view-app').hidden, true);
  assert.deepEqual(signedIn.selected(), ['overview']);
});
