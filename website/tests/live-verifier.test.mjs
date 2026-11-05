import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {verifyLive, verifyDeploymentReceipt} from '../scripts/verify-live.mjs';
import {LANDING_CSP} from '../scripts/check.mjs';

const commit = '1'.repeat(40);
async function fixture(t, mutate = () => {}) {
  const dist = await mkdtemp(join(tmpdir(), 'aipster-verifier-'));
  t.after(() => rm(dist, {recursive: true, force: true}));
  await mkdir(join(dist, 'app'));
  const data = {'index.html': '<title>Landing</title>', 'app/index.html': '<title>Sign in</title>',
    'app/app.js': '/* reviewed client */',
    'app/experiments/dsh-dgm/admin-gate.mjs': 'export const gate = 1;', 'release.json': '{}',
    'deployment.json': JSON.stringify({git_commit: commit, source_manifest_sha256: 'fixture'})};
  for (const [path, body] of Object.entries(data)) {
    await mkdir(dirname(join(dist, path)), {recursive: true});
    await writeFile(join(dist, path), body);
  }
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    const path = new URL(url).pathname;
    let status = 200, body, headers = {'Content-Type': 'application/json'};
    const asset = path === '/' ? 'index.html' : path === '/app/' ? 'app/index.html' : path.slice(1);
    if (asset in data) {
      body = data[asset]; headers['Cache-Control'] = asset.startsWith('app/') ? 'no-store' : 'public, no-transform';
      headers['Content-Type'] = asset.endsWith('.html') ? 'text/html; charset=utf-8' : /\.m?js$/.test(asset) ? 'text/javascript' : 'application/json';
      if (asset === 'index.html') headers['Content-Security-Policy'] = LANDING_CSP;
      if (asset === 'app/index.html') {
        headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
        headers['X-Content-Type-Options'] = 'nosniff';
      }
    } else if (path === '/app') { status = 302; headers.Location = '/app/'; }
    else if (path === '/api/health') body = JSON.stringify({ok: true, auth_configured: true, ready: true, detail: {oauth: false, schema: true}});
    else if (path === '/api/auth/get-session') body = 'null';
    else if (path.startsWith('/api/')) { status = 401; body = '{"code":"AUTH_REQUIRED"}'; }
    else status = 404;
    const reply = {status, body, headers}; mutate(path, reply);
    return new Response(reply.body, {status: reply.status, headers: reply.headers});
  };
  return {dist, files: Object.keys(data).filter(p => p !== 'deployment.json'), expectedCommit: commit, fetchImpl};
}
test('verifier accepts app routing/cache contract and states evidence limits', async t => {
  const result = await verifyLive(await fixture(t));
  assert.equal(result.git_commit, commit); assert.equal(result.oauth_configured, false);
  assert.equal(result.inference_verified, false); assert(result.pending.includes('two-identity isolation'));
});
for (const [name, mutate] of [
  ['unprotected inventory', (p, r) => { if (p === '/api/inventory') r.status = 200; }],
  ['missing auth configuration', (p, r) => { if (p === '/api/health') r.body = '{"ok":true,"auth_configured":false}'; }],
  ['wrong release bytes', (p, r) => { if (p === '/deployment.json') r.body = '{}'; }],
  ['app cache regression', (p, r) => { if (p === '/app/app.js') r.headers['Cache-Control'] = 'public'; }],
  ['HTML MIME regression', (p, r) => { if (p === '/app/index.html') r.headers['Content-Type'] = 'application/json'; }],
  ['script MIME regression', (p, r) => { if (p === '/app/app.js') r.headers['Content-Type'] = 'text/plain'; }],
  ['permissive CSP', (p, r) => { if (p === '/app/index.html') r.headers['Content-Security-Policy'] += '; script-src *'; }],
  ['CSP override', (p, r) => { if (p === '/app/index.html') r.headers['Content-Security-Policy'] += '; script-src-elem *'; }],
  ['missing nosniff', (p, r) => { if (p === '/app/index.html') delete r.headers['X-Content-Type-Options']; }],
  ['cross-origin redirect', (p, r) => { if (p === '/app') r.headers.Location = 'https://attacker.invalid/app/'; }],
  ['missing landing CSP', (p, r) => { if (p === '/') delete r.headers['Content-Security-Policy']; }],
  ['widened landing CSP', (p, r) => { if (p === '/') r.headers['Content-Security-Policy'] += '; script-src *'; }],
]) test(`verifier rejects ${name}`, async t => { await assert.rejects(verifyLive(await fixture(t, mutate))); });
// The reviewed experiment ships .mjs modules. They are JavaScript and must be
// recognized exactly like .js, not skipped and not waved through: a module
// served as HTML, as opaque bytes, or with no type at all still fails.
const MJS = '/app/experiments/dsh-dgm/admin-gate.mjs';
test('verifier accepts .mjs modules served as JavaScript', async t => {
  for (const type of ['text/javascript', 'application/javascript; charset=utf-8']) {
    const options = await fixture(t, (path, reply) => { if (path === MJS) reply.headers['Content-Type'] = type; });
    const result = await verifyLive(options);
    assert.equal(result.verified, true, `rejected ${type}`);
  }
});
for (const [name, apply] of [
  ['HTML', reply => { reply.headers['Content-Type'] = 'text/html; charset=utf-8'; }],
  ['opaque bytes', reply => { reply.headers['Content-Type'] = 'application/octet-stream'; }],
  ['no content type', reply => { delete reply.headers['Content-Type']; }],
]) test(`verifier rejects an .mjs module served as ${name}`, async t => {
  const options = await fixture(t, (path, reply) => { if (path === MJS) apply(reply); });
  await assert.rejects(verifyLive(options), /Incorrect content type: app\/experiments\/dsh-dgm\/admin-gate\.mjs/);
});
test('verifier refuses a build from a different commit', async t => {
  const options = await fixture(t); options.expectedCommit = '2'.repeat(40);
  await assert.rejects(verifyLive(options), /expected commit/);
});
test('verifier waits out stale edge bytes within the propagation window', async t => {
  let stale = 2, sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js' && stale > 0) { stale--; reply.body = '/* previous release */'; } });
  const result = await verifyLive({...options, propagation: {attempts: 3, delayMs: 5}, sleep: async () => { sleeps++; }});
  assert.equal(result.verified, true);
  assert.equal(sleeps, 2);
});
test('verifier still rejects bytes that stay stale past the window', async t => {
  let sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js') reply.body = '/* previous release */'; });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 3, delayMs: 5}, sleep: async () => { sleeps++; }}), /Live bytes differ: app\/app.js/);
  assert.equal(sleeps, 2);
});
test('verifier does not retry a wrong status or content type', async t => {
  let calls = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js') { calls++; reply.status = 404; } });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 5, delayMs: 5}, sleep: async () => {}}), /Expected HTTPS 200/);
  assert.equal(calls, 1);
});
test('the propagation budget is shared across assets, not per asset', async t => {
  let sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/' || path === '/app/app.js') reply.body = '/* previous release */'; });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 3, delayMs: 5}, sleep: async () => { sleeps++; }}), /Live bytes differ/);
  assert.equal(sleeps, 2, 'two retries total across every stale asset');
});
test('a malformed propagation option falls back to a single attempt', async t => {
  let sleeps = 0;
  const options = await fixture(t, (path, reply) => { if (path === '/app/app.js') reply.body = '/* previous release */'; });
  await assert.rejects(verifyLive({...options, propagation: {attempts: 'x', delayMs: -1}, sleep: async () => { sleeps++; }}), /Live bytes differ/);
  assert.equal(sleeps, 0);
});
// The build stamps deployment.json with the deploying run's own github_run_url,
// so a second run can never byte-match the first run's receipt. On the
// already-live path the receipt is validated instead of byte-compared; strict
// new-deploy verification is unchanged.
const runUrl = id => `https://github.com/synchronic1/AIPSTER/actions/runs/${id}`;
const receipt = (runId, over = {}) => ({site: 'aipster-public-site', site_revision: 'r1',
  git_commit: commit, github_run_url: runUrl(runId), source_manifest_sha256: 'fixture',
  auth_deployed: false, ...over});
async function alreadyLiveFixture(t, {localRun = '222', liveRun = '111', liveOver = {}, mutate} = {}) {
  const options = await fixture(t, (path, reply) => {
    if (path === '/deployment.json') reply.body = JSON.stringify(receipt(liveRun, liveOver));
    if (mutate) mutate(path, reply);
  });
  await writeFile(join(options.dist, 'deployment.json'), JSON.stringify(receipt(localRun)));
  return {...options, alreadyLive: true};
}
test('already-live accepts the deploying run receipt from a distinct run', async t => {
  const result = await verifyLive(await alreadyLiveFixture(t));
  assert.equal(result.verified, true);
  assert.equal(result.already_live, true);
  assert.equal(result.live_run_url, runUrl('111'));
});
test('already-live accepts when the receipt matches the local run', async t => {
  const result = await verifyLive(await alreadyLiveFixture(t, {localRun: '111', liveRun: '111'}));
  assert.equal(result.verified, true);
});
test('strict verification still rejects distinct-run receipt bytes', async t => {
  await assert.rejects(verifyLive(await alreadyLiveFixture(t).then(({alreadyLive, ...rest}) => rest)),
    /Live bytes differ: deployment\.json/);
});
test('strict verification still accepts identical receipt bytes', async t => {
  const options = await alreadyLiveFixture(t, {localRun: '111', liveRun: '111'});
  const {alreadyLive, ...rest} = options;
  assert.equal((await verifyLive(rest)).verified, true);
});
for (const [name, liveOver] of [
  ['wrong receipt SHA', {git_commit: '2'.repeat(40)}],
  ['wrong receipt manifest', {source_manifest_sha256: 'other'}],
  ['wrong receipt revision', {site_revision: 'r2'}],
  ['wrong receipt site', {site: 'other-site'}],
  ['foreign run URL', {github_run_url: 'https://github.com/someone/else/actions/runs/111'}],
  ['malformed run URL', {github_run_url: 'not-a-url'}],
  ['missing run URL', {github_run_url: undefined}],
  ['unexpected receipt field', {extra: 1}],
]) test(`already-live rejects ${name}`, async t => {
  await assert.rejects(verifyLive(await alreadyLiveFixture(t, {liveOver})));
});
test('already-live still rejects changed static bytes', async t => {
  const options = await alreadyLiveFixture(t, {mutate: (p, r) => { if (p === '/app/app.js') r.body = '/* tampered */'; }});
  await assert.rejects(verifyLive(options), /Live bytes differ: app\/app\.js/);
});
test('already-live still enforces anonymous access denials', async t => {
  const options = await alreadyLiveFixture(t, {mutate: (p, r) => { if (p === '/api/inventory') r.status = 200; }});
  await assert.rejects(verifyLive(options));
});
test('receipt validation is done by the verifier, not a mirrored helper', async t => {
  const local = receipt('222');
  assert.equal(verifyDeploymentReceipt(receipt('111'), local, commit), runUrl('111'));
  assert.throws(() => verifyDeploymentReceipt(receipt('111', {git_commit: '2'.repeat(40)}), local, commit));
});
