import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {publicFiles, sha} from './check.mjs';

// .mjs modules are JavaScript and are held to exactly the .js media types.
const JAVASCRIPT_TYPES = ['text/javascript', 'application/javascript'];
const CONTENT_TYPES = {html: ['text/html'], js: JAVASCRIPT_TYPES, mjs: JAVASCRIPT_TYPES,
  css: ['text/css'], svg: ['image/svg+xml'], png: ['image/png'], json: ['application/json'],
  mp4: ['video/mp4'], jpg: ['image/jpeg'], vtt: ['text/vtt']};
function verifyContentType(response, path) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  assert(CONTENT_TYPES[path.split('.').at(-1)]?.includes(type), `Incorrect content type: ${path}`);
}
function verifyAppSecurity(response) {
  const entries = (response.headers.get('content-security-policy') || '').split(';')
    .filter(s => s.trim()).map(s => { const [name, ...values] = s.trim().split(/\s+/); return [name, values.join(' ')]; });
  const directives = new Map(entries);
  assert.equal(entries.length, 8, 'App CSP must match the reviewed policy');
  assert.equal(directives.size, entries.length, 'App CSP must not contain duplicate directives');
  for (const [name, expected] of Object.entries({'default-src': "'none'", 'script-src': "'self'",
    'style-src': "'self'", 'connect-src': "'self'", 'img-src': "'self'", 'base-uri': "'none'",
    'form-action': "'none'", 'frame-ancestors': "'none'"})) {
    assert.equal(directives.get(name), expected, `Incorrect app CSP: ${name}`);
  }
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', 'App must disable MIME sniffing');
}

// Anonymous checks only: not proof of a real OAuth callback, authenticated
// logout, two-user isolation, or live inference. Those need approved identities.

// The build stamps deployment.json with the deploying run's own
// github_run_url, so two builds of the same commit never match byte for byte.
// On the already-live path (a distinct run confirming an existing deployment)
// the receipt is validated field by field instead of byte-compared: exact
// source SHA, exact source manifest and revision, canonical receipt shape with
// no unexpected fields, and a canonical run URL whose identity may legitimately
// differ. Every other check — static bytes, health, auth denials, 404s — is
// identical in both modes. This mode never proves a new deploy.
const RECEIPT_FIELDS = ['site', 'site_revision', 'git_commit', 'github_run_url',
  'source_manifest_sha256', 'auth_deployed'];
const CANONICAL_RUN_URL = /^https:\/\/github\.com\/synchronic1\/AIPSTER\/actions\/runs\/\d+$/;
export function verifyDeploymentReceipt(live, local, expectedCommit) {
  assert(live && typeof live === 'object' && !Array.isArray(live), 'Live deployment receipt is not an object');
  assert.deepEqual(Object.keys(live).sort(), [...RECEIPT_FIELDS].sort(),
    'Live deployment receipt has unexpected fields');
  assert.equal(live.site, 'aipster-public-site', 'Live receipt is not the public site deployment');
  assert.equal(live.git_commit, expectedCommit, 'Live receipt is not the expected commit');
  assert.equal(live.source_manifest_sha256, local.source_manifest_sha256,
    'Live receipt source manifest differs');
  assert.equal(live.site_revision, local.site_revision, 'Live receipt site revision differs');
  assert.match(live.github_run_url || '', CANONICAL_RUN_URL,
    'Live receipt run provenance is not canonical');
  assert.equal(typeof live.auth_deployed, 'boolean', 'Live receipt auth flag is malformed');
  return live.github_run_url;
}

export async function verifyLive({base = 'https://aipster.net',
  dist = resolve(import.meta.dirname, '../dist'), files = publicFiles,
  expectedCommit = process.env.GITHUB_SHA, fetchImpl = fetch,
  propagation = {attempts: 1, delayMs: 0}, sleep = ms => new Promise(r => setTimeout(r, ms)),
  alreadyLive = false} = {}) {
  const origin = new URL(base);
  assert.equal(origin.protocol, 'https:', 'Verification requires HTTPS');
  assert.equal(origin.origin, base, 'Use a canonical origin without path or credentials');
  assert(/^[a-f0-9]{40}$/.test(expectedCommit || ''), 'Supply the exact expected merged commit');
  const localDeployment = JSON.parse(await readFile(resolve(dist, 'deployment.json'), 'utf8'));
  assert.equal(localDeployment.git_commit, expectedCommit, 'Local build is not the expected commit');
  async function request(path, options = {}) {
    const response = await fetchImpl(base + path, {...options, redirect: 'manual', signal: AbortSignal.timeout(15000)});
    if (response.url) assert.equal(new URL(response.url).origin, base, 'Verification changed origin');
    return response;
  }
  async function jsonRequest(path, status, options) {
    const response = await request(path, options);
    assert.equal(response.status, status, `${path}: expected HTTP ${status}`);
    assert.match(response.headers.get('content-type') || '', /application\/json/i, `${path}: expected JSON`);
    return response.json();
  }
  // One propagation budget for the whole run, not per asset: a genuinely
  // wrong release fails within the window instead of multiplying it.
  const attempts = Math.max(1, Math.trunc(Number(propagation.attempts) || 1));
  const delayMs = Math.max(0, Number(propagation.delayMs) || 0);
  let retriesLeft = attempts - 1;
  let assets = 0;
  let liveRunUrl = localDeployment.github_run_url || null;
  for (const path of [...files, 'deployment.json']) {
    if (path === '_headers' || path === '404.html') continue;
    // Already-live path: the live bytes carry the deploying run's own stamp,
    // so the receipt is validated as legitimate instead of byte-compared.
    if (path === 'deployment.json' && alreadyLive) {
      const receipt = await jsonRequest('/deployment.json', 200);
      liveRunUrl = verifyDeploymentReceipt(receipt, localDeployment, expectedCommit);
      assets++;
      continue;
    }
    // Edge caches can serve the previous release for a short time after a
    // deploy. Only a byte mismatch is retried, within a bounded window; the
    // final attempt must still match exactly.
    const expected = sha(await readFile(resolve(dist, path)));
    let response, actual;
    for (;;) {
      response = await request(path === 'index.html' ? '/' : '/' + path);
      assert.equal(response.status, 200, `Expected HTTPS 200: ${path}`);
      verifyContentType(response, path);
      actual = sha(Buffer.from(await response.arrayBuffer()));
      if (actual === expected || retriesLeft <= 0) break;
      retriesLeft--;
      await sleep(delayMs);
    }
    assert.equal(actual, expected, `Live bytes differ: ${path}`);
    const cache = response.headers.get('cache-control') || '';
    assert(cache.includes(path.startsWith('app/') ? 'no-store' : 'no-transform'), `Incorrect cache policy: ${path}`);
    if (path === 'app/index.html') verifyAppSecurity(response);
    assets++;
  }
  const redirect = await request('/app');
  assert.equal(redirect.status, 302);
  assert.equal(new URL(redirect.headers.get('location'), base).href, base + '/app/');
  const shell = await request('/app/');
  assert.equal(shell.status, 200);
  verifyContentType(shell, 'app/index.html');
  verifyAppSecurity(shell);
  assert.equal(sha(Buffer.from(await shell.arrayBuffer())), sha(await readFile(resolve(dist, 'app/index.html'))));
  assert.match(shell.headers.get('cache-control') || '', /no-store/);
  const health = await jsonRequest('/api/health', 200);
  assert.equal(health.ok, true);
  assert.equal(health.auth_configured, true, 'Authentication is not configured');
  assert.equal(health.ready, true, 'Deployment is not ready: schema/config incomplete');
  const oauthConfigured = health.oauth_configured === true || health.detail?.oauth === true;
  const session = await jsonRequest('/api/auth/get-session', 200);
  assert(session === null || !session.user, 'Anonymous request obtained a user');
  for (const path of ['/api/inventory', '/api/grants', '/api/keys', '/api/jobs', '/api/usage', '/api/settings', '/api/audit', '/api/shared-with-me']) {
    await jsonRequest(path, 401);
  }
  await jsonRequest('/api/jobs', 401, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  for (const path of ['/website/wrangler.jsonc', '/.env', '/src/worker.js', '/migrations/0001_better_auth.sql']) {
    assert.equal((await request(path)).status, 404, `Private path exposed: ${path}`);
  }
  return {verified: true, url: base, git_commit: expectedCommit,
    source_manifest_sha256: localDeployment.source_manifest_sha256,
    assets_verified: assets, auth_configured: true, oauth_configured: oauthConfigured,
    anonymous_access_denied: true, already_live: alreadyLive, live_run_url: liveRunUrl,
    pending: ['approved-identity sign-in/callback', 'authenticated logout', 'two-identity isolation', 'real inference qualification'],
    inference_verified: false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyLive({base: process.env.AIPSTER_VERIFY_ORIGIN || 'https://aipster.net',
    propagation: {attempts: 8, delayMs: 15000},
    alreadyLive: process.env.AIPSTER_ALREADY_LIVE === 'true'});
  const output = resolve(import.meta.dirname, '../.verification');
  await mkdir(output, {recursive: true});
  await writeFile(resolve(output, 'live.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
