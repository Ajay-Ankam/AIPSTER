// Fixture-labelled REAL browser flow for the private loopback demo harness.
// One headless-shell instance, one context, CDP-driven (dependency-free
// driver imported READ-ONLY, never edited): session cookie set by the test
// runner, then the ACTUAL UI Submit button drives admission→jobs→poll→result
// through the real handlers with the fake-synthetic upstream at desktop
// (1440) and mobile (390) viewports. Screenshots always land in the run
// receipt dir, plus $PRIVATE_DEMO_SHOTS when set. Run explicitly:
//   node --test website/scripts/private-inference-demo-browser.test.mjs
// (NOT in the repo's broad globs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness, runFakePlayerOnce, waitForJobQueued, SYNTHETIC_PREFIX } from './private-inference-demo.mjs';

const PORT = 18734;
const CDP_PORT = 19333;
const DRIVER = 'C:\\Users\\NM2\\Documents\\Codex\\2026-10-30\\task-4\\goose-evidence\\dashboard-preview-20261102-7007d08\\cdp-preview.mjs';
const UI_PATH = '/app/experiments/inference-demo/';
const DESKTOP = { w: 1440, h: 900, mobile: false };
const MOBILE = { w: 390, h: 844, mobile: true };

function shotsDir(fallback) {
  const dir = process.env.PRIVATE_DEMO_SHOTS || fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
}
function jobsPostCount(api) {
  return api.events().filter((e) => e.method === 'Network.requestWillBeSent'
    && e.params && e.params.request && e.params.request.method === 'POST'
    && String(e.params.request.url || '').includes('/api/jobs')).length;
}
async function setSessionCookie(api, baseUrl, cookie) {
  const eq = cookie.indexOf('=');
  await api.raw('Network.enable');
  await api.raw('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1),
    domain: '127.0.0.1', path: '/' });
  void baseUrl;
}
const textOf = (id) => `document.getElementById(${JSON.stringify(id)}).textContent`;
// F1: prove the settled pixels are in frame (not just asserted via DOM).
async function assertInViewport(api, id) {
  const v = await api.eval(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();`
    + ' return { top: r.top, bottom: r.bottom, ih: window.innerHeight }; })()');
  assert.ok(v.top < v.ih && v.bottom > 0, `${id} intersects the captured viewport`);
}
async function overflowReport(api) {
  const doc = await api.eval('({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth})');
  const offenders = await api.eval('(() => { const out = [];'
    + ' for (const el of document.querySelectorAll("*")) {'
    + ' const r = el.getBoundingClientRect();'
    + ' if (r.right > (window.innerWidth + 0.5)) out.push(el.tagName + (el.id ? "#" + el.id : "") + " right=" + r.right.toFixed(1)); }'
    + ' return out.slice(0, 10); })()');
  return { ...doc, offenders };
}

async function runUiFlow(t, api, h, { modelInput }) {
  await api.navigate(`${h.baseUrl}${UI_PATH}`);
  // Session + live inventory through the real handlers (not anonymous).
  await api.waitFor(`${textOf('session-state')}.includes('Signed in as')`, 10000);
  const sessionText = await api.eval(textOf('session-state'));
  // UI shows user.email (synthetic TEST address); the display name form is
  // covered handler-side via /api/settings.
  assert.match(sessionText, /test-harness\+.*@test\.invalid/);
  await api.waitFor(`document.getElementById('inventory-select').options.length >= 1`, 10000);
  const selected = await api.eval(`document.getElementById('inventory-select').value`);
  assert.equal(selected, h.world.resourceId);
  // Real typing into model + prompt; tokens/deadline/runtime stay at defaults.
  await api.eval(`document.getElementById('model-input').focus()`);
  await api.raw('Input.insertText', { text: modelInput });
  await api.eval(`document.getElementById('prompt-input').focus()`);
  await api.raw('Input.insertText', { text: 'Say hi from the private demo browser.' });
  assert.equal(await api.eval(`document.getElementById('model-input').value`), modelInput);
  assert.equal(await api.eval(`document.getElementById('submit-btn').disabled`), false);
  await api.click('#submit-btn');
  // One explicit click → key retained, submit locked while in flight.
  await api.waitFor(`${textOf('key-line')}.length > 0`, 10000);
  assert.equal(await api.eval(`document.getElementById('submit-btn').disabled`), true);
  // HOLD029: the key line is written synchronously at click time, before
  // admission/job creation completes — wait for the queued job itself.
  const ready = await waitForJobQueued(h.DB, { timeoutMs: 10000 });
  assert.equal(ready.ready, true, 'job queued before the single-shot fake-player lease');
  // Attributed synthetic worker completes through the real worker routes.
  const played = await runFakePlayerOnce(h, { heartbeatSecret: h.world.heartbeatSecret });
  assert.equal(played.played, true);
  await api.waitFor(`${textOf('status-line')}.includes('Settled')`, 20000);
  const content = await api.eval(textOf('result-pre'));
  assert.ok(content.startsWith(SYNTHETIC_PREFIX), 'synthetic label visible in UI');
  const provenance = await api.eval(textOf('provenance-line'));
  assert.match(provenance, /Worker-reported/);
  assert.equal(jobsPostCount(api), 1, 'exactly one jobs POST: no resubmission');
  t.diagnostic(`settled key=${await api.eval(textOf('key-line'))}`);
}

test('fixture: desktop 1440 browser flow (real click → settled synthetic)', async (t) => {
  if (!existsSync(DRIVER)) throw new Error('HARNESS: CDP driver missing (read-only prerequisite): ' + DRIVER);
  const driver = await import(pathToFileURL(DRIVER).href);
  const h = await createHarness({ port: PORT });
  await h.start();
  const api = await driver.launch({ cdpPort: CDP_PORT, width: DESKTOP.w, height: DESKTOP.h, mobile: DESKTOP.mobile });
  try {
    await setSessionCookie(api, h.baseUrl, h.world.operator.cookie);
    await runUiFlow(t, api, h, { modelInput: 'TEST-model' });
    const dir = shotsDir(h.dir);
    const shot = path.join(dir, 'private-demo-desktop-1440.png');
    await api.shot(shot);
    t.diagnostic(`shot: ${shot}`);
    const overflow = await api.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
    if (overflow !== true) t.diagnostic('overflow@1440: ' + JSON.stringify(await overflowReport(api)));
    assert.equal(overflow, true, 'no horizontal overflow at 1440');
    // F1: result-visible capture at 1440x1000 (existing 1440 shot retained above).
    await api.viewport(1440, 1000, false);
    await api.eval(`document.getElementById('result-pre').scrollIntoView({ block: 'center' })`);
    await assertInViewport(api, 'result-pre');
    await assertInViewport(api, 'status-line');
    const settled = path.join(dir, 'private-demo-desktop-1440-settled.png');
    await api.shot(settled);
    t.diagnostic(`settled shot: ${settled}`);
  } finally {
    const report = await api.close();
    assert.equal(report.dirRemoved, true);
    assert.ok(!('unverifiedPid' in report) && !('unverifiedOrAlivePid' in report));
    await h.stop();
  }
});

test('fixture: mobile 390 browser flow after clean restart (real click → settled)', async (t) => {
  if (!existsSync(DRIVER)) throw new Error('HARNESS: CDP driver missing (read-only prerequisite): ' + DRIVER);
  const driver = await import(pathToFileURL(DRIVER).href);
  // Fresh harness on the SAME port proves clean stop/port reuse.
  const h = await createHarness({ port: PORT });
  await h.start();
  const api = await driver.launch({ cdpPort: CDP_PORT, width: MOBILE.w, height: MOBILE.h, mobile: MOBILE.mobile });
  try {
    await setSessionCookie(api, h.baseUrl, h.world.operator.cookie);
    await api.navigate(`${h.baseUrl}${UI_PATH}`);
    await api.waitFor(`${textOf('session-state')}.includes('Signed in as')`, 10000);
    const overflowBefore = await api.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
    if (overflowBefore !== true) t.diagnostic('overflow@390-before: ' + JSON.stringify(await overflowReport(api)));
    assert.equal(overflowBefore, true, 'no horizontal overflow at 390 before submit');
    await api.eval(`document.getElementById('model-input').focus()`);
    await api.raw('Input.insertText', { text: 'TEST-model' });
    await api.eval(`document.getElementById('prompt-input').focus()`);
    await api.raw('Input.insertText', { text: 'Mobile hello.' });
    await api.click('#submit-btn');
    await api.waitFor(`${textOf('key-line')}.length > 0`, 10000);
    // HOLD029: key line precedes completed admission/job creation — wait
    // for the queued job itself before the single-shot lease.
    const ready = await waitForJobQueued(h.DB, { timeoutMs: 10000 });
    assert.equal(ready.ready, true, 'job queued before the single-shot fake-player lease');
    const played = await runFakePlayerOnce(h, { heartbeatSecret: h.world.heartbeatSecret });
    assert.equal(played.played, true);
    await api.waitFor(`${textOf('status-line')}.includes('Settled')`, 20000);
    const content = await api.eval(textOf('result-pre'));
    assert.ok(content.startsWith(SYNTHETIC_PREFIX));
    assert.equal(jobsPostCount(api), 1);
    const overflowAfter = await api.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
    if (overflowAfter !== true) t.diagnostic('overflow@390-after: ' + JSON.stringify(await overflowReport(api)));
    assert.equal(overflowAfter, true, 'no horizontal overflow at 390 after result');
    const dir = shotsDir(h.dir);
    const shot = path.join(dir, 'private-demo-mobile-390.png');
    await api.shot(shot);
    t.diagnostic(`shot: ${shot}`);
    // F1: result-visible capture at 390x844 (existing 390 shot retained above).
    await api.viewport(390, 844, true);
    await api.eval(`document.getElementById('result-pre').scrollIntoView({ block: 'center' })`);
    await assertInViewport(api, 'result-pre');
    await assertInViewport(api, 'status-line');
    const settled = path.join(dir, 'private-demo-mobile-390-settled.png');
    await api.shot(settled);
    t.diagnostic(`settled shot: ${settled}`);
  } finally {
    const report = await api.close();
    assert.equal(report.dirRemoved, true);
    assert.ok(!('unverifiedPid' in report) && !('unverifiedOrAlivePid' in report));
    await h.stop();
  }
});
