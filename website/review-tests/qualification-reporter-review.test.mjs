/* Independent verification lane: cross-language reporter -> hosted contract.
 * EXPLICITLY INVOKED supplemental verification (outside the default npm test
 * glob; see review-tests/README.md). Runs the REAL local-worker reporter
 * (build_capability_report + runtime_models_entry) against a real dendrite
 * TOML fixture, feeds the produced JSON through the REAL intake validation
 * (heartbeat POST), normalizeProfile, eligibleCatalog, and the full
 * post -> lease -> runner-shaped result chain on isolated real Miniflare D1
 * via the actual worker.js fetch transport. Synthetic non-demo owner +
 * synthetic heartbeat key; nothing persists (DB disposed after).
 * Prerequisites: `uv` on PATH; pinned pydantic==2.14.2 + psutil==7.2.2 are
 * resolved by uv (cache or network) at this explicit invocation only — never
 * part of the default Node suite. Missing `uv` fails loudly, never skips.
 * Reporter access is via reporter_probe.py with structured argv only
 * (no code interpolation). Honest scope: no live worker exists here, so
 * attach entries are absent (probe-gated, as designed) and managed entries
 * carry no models; the success-bind case merges models ONLY from the real
 * runtime_models_entry helper output and is labeled reporter-composed.
 * Never invents a 'ganglion' snapshot entry: the reporter never emits one.
 * Owned by verification lane. No implementation edits. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES, signSessionCookie, TEST_SECRET } from '../tests/d1-shim.mjs';
import { mintKey, verifierFor } from '../src/lib/keys.js';
import { normalizeProfile, eligibleCatalog, canonicalProfileDigest } from '../src/qualification/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROBE = path.join(HERE, 'reporter_probe.py');
const BASE = 'http://localhost:8787';
const FIXTURE_TOML = path.join(ROOT, '.verification', 'dendrite-reporter.toml');
const PY_DEPS = ['pydantic==2.14.2', 'psutil==7.2.2'];
let mf = null;
let db = null;
let worker = null;
let aliceCookie = '';
let hb = {};

const reporterToml = (exe) => `[[runtimes]]
id = "managed-cpu"
kind = "llama_cpp"
mode = "managed"
executable = "${exe}"
port = 8081

[[runtimes]]
id = "attach-cpu"
kind = "llama_cpp"
mode = "attach"
base_url = "http://127.0.0.1:8091"
port = 8091

[[runtimes]]
id = "mock-0"
kind = "mock"
mode = "managed"
port = 8092

[[models]]
id = "fixture-llama"
runtime = "managed-cpu"
capabilities = ["completion"]
path = "models/fixture.gguf"

[[models]]
id = "fixture-attach"
runtime = "attach-cpu"
capabilities = ["completion"]
upstream_model = "fixture-attach"
`;

/**
 * Run the real reporter via reporter_probe.py (structured argv only).
 * Fails loudly when `uv`/deps are unavailable — never silently skips.
 */
function probe(...args) {
  let out;
  try {
    out = execFileSync('uv',
      ['run', ...PY_DEPS.flatMap((d) => ['--with', d]), '--no-project', 'python', PROBE, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (e) {
    if (e?.code === 'ENOENT' || /not recognized|not found/i.test(String(e?.message || e))) {
      throw new Error('reporter review prerequisites missing: `uv` must be on PATH (see review-tests/README.md); refusing to skip.');
    }
    throw new Error(`reporter probe failed (see review-tests/README.md for prerequisites): ${e?.message || e}`);
  }
  return JSON.parse(out);
}

const reportFor = (toml) => probe('report', toml);
const modelsFor = (name, ids) => probe('models', name, ...ids);

const call = async (pathname, { method = 'GET', headers = {}, body } = {}, envOver = {}) => {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const env = { DB: db, BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: BASE, QUALIFICATION_ENABLED: '1', ASSETS: { fetch: async () => new Response('x', { status: 404 }) }, ...envOver };
  const res = await worker.default.fetch(new Request(BASE + pathname, init), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
};

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'qual-reporter-test' },
  }));
  db = await mf.getD1Database('DB');
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(path.join(ROOT, 'migrations', file), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    for (const stmt of sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      await db.exec(`${stmt};`);
    }
  }
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind('alice@x.invalid', now).run();
  await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('u_alice', 'u_alice', 'alice@x.invalid', 1, null, now, now).run();
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('s_' + token.slice(0, 8), new Date(Date.now() + 12 * 3600 * 1000).toISOString(), token, now, now, null, 'test', 'u_alice').run();
  aliceCookie = `better-auth.session_token=${signSessionCookie(token, TEST_SECRET)}`;
  await db.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('r_rep', 'u_alice', 'n-rep', 'node', 'test', 'x', 'none', now).run();
  const minted = mintKey();
  const salt = randomBytes(16).toString('hex');
  await db.prepare(
    'INSERT INTO key_verifiers (id, owner_id, name, scope, resource_id, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
  ).bind(minted.id, 'u_alice', 'rep-hb', 'heartbeat', 'r_rep', salt, await verifierFor(minted.secret, salt), 'aip_live_' + minted.id, null, 'reporter harness', now).run();
  hb = { Authorization: `Bearer ${minted.secret}` };
  worker = await import(`../src/worker.js?reporter-review-${randomBytes(4).toString('hex')}`);
});

after(async () => { await mf.dispose(); });

const csrf = { 'X-Aipster-CSRF': '1' };
const asAlice = () => ({ Cookie: aliceCookie, ...csrf });
// ISO Zulu: a TZ-naive stamp parses as local time and can look future,
// tripping the 25 s guard. Real server rows are always ISO Zulu.
const backdateCaps = () => db.prepare('UPDATE node_capabilities SET reported_at = ? WHERE node_id = ?')
  .bind(new Date(Date.now() - 3600e3).toISOString(), 'r_rep').run();
const runnerResult = (leaseId, modelId) => ({
  leaseId, status: 'succeeded',
  result: { runtimeId: 'llama-server', modelId, elapsedMs: 1200, promptTokens: 8, completionTokens: 32, finishReason: 'stop' },
});

let realReport = null;

test('reporter emits only real runtime names from a real config fixture', () => {
  writeFileSync(FIXTURE_TOML, reporterToml(process.execPath.replace(/\\/g, '/')), 'utf8');
  realReport = reportFor(FIXTURE_TOML);
  assert.equal(realReport.schema_version, 1);
  const names = realReport.runtimes.map((r) => r.name);
  assert.ok(names.length >= 1, 'managed entry reported');
  assert.ok(names.every((n) => n === 'llama-server' || n === 'ik_llama-server'), `real names only, got ${names}`);
  assert.ok(!names.includes('ganglion'), 'reporter never emits ganglion');
  assert.ok(!names.includes('mock'), 'mock is never capacity');
  const managed = realReport.runtimes.find((r) => r.name === 'llama-server');
  assert.ok(managed && !('models' in managed), 'managed entry carries no models without a live probe');
  assert.equal(managed.mode, 'managed', 'reporter tags the transport mode');
});

test('intake accepts the real report shape via heartbeat transport', async () => {
  const r = await call('/api/resources/r_rep/capabilities', { method: 'POST', headers: hb, body: realReport });
  assert.equal(r.status, 200);
  const row = await db.prepare('SELECT * FROM node_capabilities WHERE node_id = ?').bind('r_rep').first();
  assert.equal(JSON.parse(row.runtimes_json)[0].name, 'llama-server');
});

test('normalize + eligible + digest are stable for the real report', async () => {
  const row = await db.prepare('SELECT * FROM node_capabilities WHERE node_id = ?').bind('r_rep').first();
  const p = normalizeProfile(row);
  assert.deepEqual(eligibleCatalog(p), ['completion-smoke-v1']);
  const a = await canonicalProfileDigest(p, { nodeId: 'r_rep', mode: 'fixture' });
  const b = await canonicalProfileDigest(normalizeProfile(row), { nodeId: 'r_rep', mode: 'fixture' });
  assert.equal(a, b);
});

test('managed entry without models evidence fails closed, never succeeds', async () => {
  const post = await call('/api/resources/r_rep/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 'rep-1' } });
  assert.equal(post.status, 200);
  const run = post.json.assignment.run_id;
  const lease = post.json.assignment.lease_id;
  const nx = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(nx.status, 200);
  assert.equal(nx.json?.runId, run);
  const done = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb, body: runnerResult(lease, 'fixture-llama') });
  assert.equal(done.status, 200);
  assert.equal(done.json?.state, 'unsupported');
});

test('reporter-composed models bind same-mode success, refuse cross-mode', async () => {
  // Reporter-composed (not full reporter output): the real report above plus
  // ONLY the real runtime_models_entry helper output merged in Node.
  const entry = reportFor(FIXTURE_TOML);
  const llama = entry.runtimes.find((r) => r.name === 'llama-server');
  assert.ok(llama, 'managed llama-server entry present');
  llama.models = modelsFor('llama-server', ['fixture-llama']).models;
  assert.deepEqual(llama.models, ['fixture-llama']);
  // Fresh identity regardless of whether ready-models stay in the digest
  // (P2-1 pending): bump a stable byte count as well.
  const withModels = { ...entry, mem: { ramTotalBytes: entry.mem.ramTotalBytes + 1024 ** 3, ramAvailBytes: entry.mem.ramAvailBytes } };
  await backdateCaps();
  const up = await call('/api/resources/r_rep/capabilities', { method: 'POST', headers: hb, body: withModels });
  assert.equal(up.status, 200);
  const post = await call('/api/resources/r_rep/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 'rep-2' } });
  assert.equal(post.status, 200);
  assert.equal(post.json?.cached, undefined);
  const run = post.json.assignment.run_id;
  const lease = post.json.assignment.lease_id;
  const nx = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(nx.status, 200);
  assert.equal(nx.json?.runId, run);
  const done = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb, body: runnerResult(lease, 'fixture-llama') });
  assert.equal(done.status, 200);
  assert.equal(done.json?.state, 'succeeded');
  const memBump = (report, add) => ({ ...report, mem: { ramTotalBytes: report.mem.ramTotalBytes + add, ramAvailBytes: report.mem.ramAvailBytes } });
  await backdateCaps();
  const up3 = await call('/api/resources/r_rep/capabilities', { method: 'POST', headers: hb, body: memBump(withModels, 2 * 1024 ** 3) });
  assert.equal(up3.status, 200);
  const other = await call('/api/resources/r_rep/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 'rep-3' } });
  assert.equal(other.status, 200);
  assert.equal(other.json?.cached, undefined);
  const run3 = other.json.assignment.run_id;
  const lease3 = other.json.assignment.lease_id;
  const nx3 = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(nx3.status, 200);
  assert.equal(nx3.json?.runId, run3);
  const wrongModel = await call(`/api/worker/qualifications/${run3}/result`, { method: 'POST', headers: hb, body: runnerResult(lease3, 'other-model') });
  assert.equal(wrongModel.status, 403);
  const cross = await call(`/api/worker/qualifications/${run3}/result`, { method: 'POST', headers: hb, body: { ...runnerResult(lease3, 'fixture-llama'), result: { ...runnerResult(lease3, 'fixture-llama').result, runtimeId: 'ganglion' } } });
  assert.equal(cross.status, 200);
  assert.equal(cross.json?.state, 'unsupported');
});
