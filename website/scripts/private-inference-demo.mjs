// Private loopback-only inference-demo harness (TEST ONLY — never shipped).
//
// Serves the ACTUAL candidate UI bytes + the ACTUAL worker fetch handlers
// (incl. real Better Auth session validation) on 127.0.0.1 with an
// ephemeral synthetic identity in an isolated temp DB. Default upstream is
// offline synthetic with conspicuous TEST labels; no real model endpoint
// fallback exists. Real-mode execution is proposal-gated below and is NEVER
// run without an explicit operator confirmation action.
//
// Owned files: this script + private-inference-demo.{test,browser.test}.mjs
// + private-inference-demo.README.md. It edits no production source.
import http from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createD1Shim, applyMigrations, sessionCookieHeader } from '../tests/d1-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LANE_ROOT = path.resolve(ROOT, '..');
const PUBLIC_ROOT = path.join(ROOT, 'public');
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 18731;
export const DEFAULT_OWNER_TOKENS = '4096';
export const UI_FILES = [
  'app/experiments/inference-demo/index.html',
  'app/experiments/inference-demo/app.js',
  'app/experiments/inference-demo/contract.mjs',
  'app/experiments/inference-demo/styles.css',
];
export const SYNTHETIC_PREFIX = '[SYNTHETIC TEST FIXTURE \u2014 no model executed] ';
export const TEST_IDENTITY_NAME = 'TEST Harness Operator';
const SECRET_KEY_RE = /secret|token|cookie|password|authorization|set-cookie/i;

export function harnessError(what) {
  const e = new Error('HARNESS: ' + what);
  e.code = 'HARNESS';
  return e;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
}

function fp(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

function candidateRev() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function createFileAssets(hits) {
  return {
    async fetch(input) {
      const req = input instanceof Request ? input : new Request(input);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 });
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url).pathname);
      } catch {
        return new Response('bad path', { status: 400 });
      }
      let resolved = path.normalize(path.join(PUBLIC_ROOT, pathname));
      if (resolved !== PUBLIC_ROOT && !resolved.startsWith(PUBLIC_ROOT + path.sep)) {
        return new Response('not found', { status: 404 });
      }
      hits.push(pathname);
      try {
        const st = statSync(resolved, { throwIfNoEntry: false });
        if (!st) return new Response('asset missing', { status: 404 });
        // Mirror edge ASSETS directory behavior: a directory path serves its
        // index.html (the demo shell), exactly like production.
        if (st.isDirectory()) resolved = path.join(resolved, 'index.html');
        const data = readFileSync(resolved);
        const ext = path.extname(resolved).toLowerCase();
        const headers = { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' };
        if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(data, { status: 200, headers });
      } catch {
        return new Response('asset unreadable', { status: 404 });
      }
    },
  };
}
async function loadWorker() {
  try {
    return (await import(pathToFileURL(path.join(ROOT, 'src', 'worker.js')).href)).default;
  } catch (e) {
    throw harnessError('cannot load the real worker handler (needs the pinned '
      + 'better-auth dependency resolvable under website/node_modules; test-runner '
      + 'setup, no install performed here): ' + (e && e.message ? e.message : e));
  }
}

async function readBody(req, cap = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw harnessError('request body exceeds harness cap');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createHarness({ port = DEFAULT_PORT, dbPath = null, ownerTokens = DEFAULT_OWNER_TOKENS,
    receiptDir = null, upstream = 'fake', mode = null, worldSetup = 'fake', log = () => {} } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw harnessError('port must be an integer in 1024..65535');
  if (upstream !== 'fake') throw harnessError(`unknown upstream mode ${JSON.stringify(upstream)} (this entry point serves fake-synthetic only)`);
  if (worldSetup !== 'fake' && worldSetup !== 'real-pairing') {
    throw harnessError(`unknown world setup ${JSON.stringify(worldSetup)} (want 'fake' or 'real-pairing')`);
  }
  if (typeof ownerTokens !== 'string' || !/^[1-9][0-9]{0,8}$/.test(ownerTokens)) {
    throw harnessError('owner tokens must be a positive integer string');
  }
  const baseUrl = `http://${HOST}:${port}`;
  const dir = receiptDir || mkdtempSync(path.join(os.tmpdir(), 'private-demo-'));
  mkdirSync(dir, { recursive: true });
  const uiFiles = UI_FILES.map((rel) => {
    const abs = path.join(PUBLIC_ROOT, rel);
    if (!existsSync(abs)) throw harnessError(`candidate UI file missing: ${rel}`);
    return { path: rel, sha256: sha256File(abs) };
  });
  const secret = crypto.randomBytes(32).toString('hex');
  const sqlite = new DatabaseSync(dbPath || ':memory:');
  applyMigrations(sqlite);
  const DB = createD1Shim(sqlite);
  const assetsHits = [];
  const env = { DB, ASSETS: createFileAssets(assetsHits), BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: baseUrl, INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: ownerTokens };
  const worker = await loadWorker();
  const ledger = [];
  const startedAt = new Date().toISOString();
  const note = (event, detail) => { ledger.push({ at: new Date().toISOString(), event, detail: detail || null }); };

  const direct = async (pathname, { method = 'GET', headers = {}, body } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    return worker.fetch(new Request(baseUrl + pathname, init), env);
  };
  const directJson = async (...args) => {
    const res = await direct(...args);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };

  const seedIdentity = async (email, name, id) => {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await DB.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind(email, now).run();
    await DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, email, 1, null, now, now).run();
    const token = crypto.randomBytes(32).toString('hex');
    await DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('s_' + token.slice(0, 8), future, token, now, now, null, 'private-demo-harness', id).run();
    return { id, name, email, token, cookie: sessionCookieHeader(token, secret) };
  };

  // Test-runner setup through REAL routes (session + CSRF like a browser).
  // 'fake' (default): operator + peer + one inventory TEST resource with a
  // harness-held heartbeat key for the offline fake player. 'real-pairing':
  // operator + peer ONLY — the paired worker CLI claims its own resource
  // and heartbeat key, so no harness-held worker credential may exist.
  const setupTestWorld = async () => {
    const operator = await seedIdentity(`test-harness+${crypto.randomBytes(4).toString('hex')}@test.invalid`, TEST_IDENTITY_NAME, 'u_test_operator');
    const peer = await seedIdentity(`test-peer+${crypto.randomBytes(4).toString('hex')}@test.invalid`, 'TEST Isolation Peer', 'u_test_peer');
    if (worldSetup === 'real-pairing') {
      note('world-ready', { world_setup: 'real-pairing', operator: operator.id, peer: peer.id, resource_id: null });
      return { operator, peer, resourceId: null, heartbeatSecret: null };
    }
    const S = { Cookie: operator.cookie, 'X-Aipster-CSRF': '1' };
    const reg = await directJson('/api/inventory', { method: 'POST', headers: S,
      body: { name: 'TEST-loopback-worker', kind: 'local', origin: 'harness', cpu: 'TEST', gpu: 'TEST-none' } });
    if (reg.status !== 201) throw harnessError(`TEST resource registration failed: ${reg.status} ${reg.text.slice(0, 200)}`);
    const resourceId = reg.json.id;
    const key = await directJson('/api/keys', { method: 'POST', headers: S,
      body: { name: 'TEST-heartbeat', scope: 'heartbeat', resourceId } });
    if (key.status !== 201) throw harnessError(`TEST heartbeat key mint failed: ${key.status} ${key.text.slice(0, 200)}`);
    const beat = await directJson(`/api/resources/${resourceId}/heartbeat`, { method: 'POST',
      headers: { Authorization: `Bearer ${key.json.secret}` }, body: JSON.stringify({ usable: true }) });
    if (beat.status !== 200) throw harnessError(`TEST heartbeat failed: ${beat.status} ${beat.text.slice(0, 200)}`);
    note('world-ready', { resource_id: resourceId, heartbeat_fp: fp(key.json.secret), operator: operator.id, peer: peer.id });
    return { operator, peer, resourceId, heartbeatSecret: key.json.secret };
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (host !== `${HOST}:${port}`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Loopback harness rejects non-loopback Host.', code: 'HARNESS_HOST_REJECTED' }));
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== baseUrl) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Loopback harness rejects foreign Origin.', code: 'HARNESS_ORIGIN_REJECTED' }));
        return;
      }
      const rawBody = (req.method === 'GET' || req.method === 'HEAD') ? null : await readBody(req);
      const fwd = { ...req.headers };
      delete fwd.host;
      delete fwd.connection;
      delete fwd['content-length'];
      const init = { method: req.method, headers: fwd };
      if (rawBody !== null) init.body = rawBody;
      const out = await worker.fetch(new Request(baseUrl + (req.url || '/'), init), env);
      const buf = Buffer.from(await out.arrayBuffer());
      const headers = {};
      out.headers.forEach((v, k) => { headers[k] = v; });
      headers['content-length'] = String(buf.length);
      res.writeHead(out.status, headers);
      if (req.method === 'HEAD') res.end();
      else res.end(buf);
    } catch (e) {
      log('request failed: ' + (e && e.message ? e.message : e));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Harness request failure.', code: 'HARNESS_REQUEST_FAILED' }));
      } else res.end();
    }
  });

  const h = {
    baseUrl, port, dir, env, DB, sqlite, ledger, uiFiles, assetsHits,
    candidateRev: candidateRev(), completions: 0, world: null, server: null,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (e) => {
          server.off('error', onError);
          reject(harnessError(`cannot bind owned loopback port ${port} (refusing to steal it): ${e.code || e.message}`));
        };
        server.on('error', onError);
        server.listen(port, HOST, () => { server.off('error', onError); resolve(); });
      });
      const addr = server.address();
      if (!addr || addr.address !== HOST) throw harnessError(`bound to unexpected address ${addr && addr.address}`);
      note('server-up', { base_url: baseUrl });
      h.world = await setupTestWorld();
      h.server = server;
      return h;
    },
    writeReceipt(extra) {
      const receipt = stripSecrets({ harness: 'private-inference-demo/v1', candidate_rev: h.candidateRev,
        mode: mode || 'fake-synthetic', base_url: baseUrl, db_mode: dbPath ? 'temp-file' : 'memory',
        db_path: dbPath || null, ui_files: uiFiles, started_at: startedAt,
        stopped_at: new Date().toISOString(), ledger, ...extra });
      writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
      return path.join(dir, 'receipt.json');
    },
    async stop(receiptExtra = null) {
      await new Promise((resolve) => server.close(() => resolve()));
      try { sqlite.close(); } catch { /* already closed */ }
      note('server-down', null);
      return h.writeReceipt(receiptExtra || {});
    },
  };
  return h;
}
// HOLD029 readiness: the UI writes its retained idempotency key synchronously
// at click time, BEFORE the admission/job POSTs complete — so "key line
// nonempty" does NOT imply a queued job. Callers wait for the actual
// precondition (a queued dispatch row) and only then invoke the single-shot
// player below. Read-only; resolves {ready:false} on timeout rather than
// throwing, so callers fail with context instead of racing the lease.
export async function waitForJobQueued(db, { timeoutMs = 10000, intervalMs = 50, idempotencyKey = null } = {}) {
  const start = Date.now();
  const keyed = typeof idempotencyKey === 'string' && idempotencyKey.length > 0;
  for (;;) {
    let row;
    if (keyed) {
      // The one job admitted for THIS browser key (op_key carries the
      // principal-scoped idempotency key; INSTR avoids LIKE wildcards).
      row = await db.prepare(
        'SELECT j.job_id AS job_id FROM dispatch_jobs j JOIN dispatch_operations o ON o.job_id = j.job_id '
        + "WHERE j.status = 'queued' AND INSTR(o.op_key, ?) > 0 LIMIT 1").bind(idempotencyKey).first();
    } else {
      row = await db.prepare(
        "SELECT job_id FROM dispatch_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").first();
    }
    if (row && row.job_id) return { ready: true, job_id: row.job_id };
    if (Date.now() - start >= timeoutMs) return { ready: false, job_id: null };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
// One synthetic completion per harness run (default). Echoes ONLY server-issued
// binding/task pins; content is conspicuously synthetic; elapsed is honestly
// zero and usage carries no fabricated metrics. `simulated:false` is the
// contract's required channel marker (normalizeResult rejects anything else);
// the fixture nature is labelled in content, TEST identity/resource names,
// and the run receipt — never implied by the flag alone.
export async function runFakePlayerOnce(h, { heartbeatSecret, completionsAllowed = 1 } = {}) {
  if (h.completions >= completionsAllowed) {
    h.ledger.push({ at: new Date().toISOString(), event: 'player-refused', detail: 'one-dispatch-limit' });
    return { played: false, reason: 'one-dispatch-limit' };
  }
  const next = await fetch(`${h.baseUrl}/api/worker/jobs/next`, {
    headers: { Authorization: `Bearer ${heartbeatSecret}` },
  });
  if (next.status === 204) return { played: false, reason: 'no-lease' };
  if (!next.ok) throw harnessError(`fake player lease read failed: ${next.status}`);
  const lease = await next.json();
  const env = lease && lease.envelope;
  if (!lease || typeof lease.job_id !== 'string' || typeof lease.lease_id !== 'string'
    || !env || !env.task || !env.binding) {
    throw harnessError('fake player refused malformed lease (unknown outcome: nothing posted)');
  }
  const result = {
    request_id: lease.job_id,
    node_id: env.task?.placement?.node_id,
    runtime_id: env.task?.placement?.runtime_id,
    model_id: env.task?.model_id,
    runtime_instance: env.binding?.runtime_instance,
    model_fingerprint: env.binding?.model_fingerprint,
    simulated: false,
    content: SYNTHETIC_PREFIX + `TEST completion for the admitted prompt (no model executed; harness fake upstream).`,
    elapsed_ms: 0,
    usage: { synthetic: true },
    cache: {},
  };
  const posted = await fetch(`${h.baseUrl}/api/worker/jobs/${lease.job_id}/result`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${heartbeatSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lease_id: lease.lease_id, status: 'succeeded', result }),
  });
  const text = await posted.text();
  if (posted.status !== 200) throw harnessError(`fake player result rejected: ${posted.status} ${text.slice(0, 200)}`);
  h.completions += 1;
  h.ledger.push({ at: new Date().toISOString(), event: 'player-completed',
    detail: { job_id: lease.job_id, synthetic: true, content_prefix: true, elapsed_ms: 0 } });
  return { played: true, job_id: lease.job_id };
}

// ---------- Real-mode preflight / proposal (APPROVAL-GATED, never auto-run) ----------
// A future approved real run uses ONLY existing pinned assets per
// CPU-PROOF-RUNTIME-HANDOFF.md (same llama-server path, GGUF path+bytes,
// alias, argv shape incl. `--n-gpu-layers 0`). Difference vs that handoff's
// §PROPOSAL (UI-observe-only): this task authorizes exactly one
// BROWSER-ISSUED dispatch when approved. Neither executes here.
export const REAL_PROPOSAL_SCHEMA = 'private-demo-real-proposal/v1';
const REAL_RUNTIMES = ['ganglion', 'llama-server'];
// Pinned real-mode assets — ONLY these paths/hashes may be proposed. Source:
// goose-evidence/worker-priority-20261103/CPU-ASSET-PREFLIGHT-20261104.json
// (verified 2026-11-04; engine entry is the 9216-byte WinGet shim). Any asset
// change needs a code change + review, never a broader proposal.
export const PINNED_ASSETS = {
  engine: { path: 'C:\\Users\\NM2\\AppData\\Local\\Microsoft\\WinGet\\Packages\\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\\llama-server.exe',
    bytes: 9216, sha256: '3e0ce12e0ab22f6110fd749a94934e237f770d9e64c2108e8df936599f5f200d' },
  gguf: { path: 'C:\\Users\\NM2\\models\\smollm2-135m\\SmolLM2-135M-Instruct-Q4_K_M.gguf',
    bytes: 105454432, sha256: '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d' },
};
const PINNED_ARGV_FLAGS = ['-m', '--port', '--alias', '--n-gpu-layers'];

function isLoopbackHttp(u) {
  return u.protocol === 'http:' && u.hostname === '127.0.0.1'
    && !u.username && !u.password && !u.search && !u.hash;
}

function argvHas(argv, flag, value) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] === value;
}

export function sanitizeArgv(argv) {
  // Redacts secret-ish flags AND the value following --code (the worker
  // pair command carries the one-time pairing code as a bare value).
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (/key|secret|token|password|code/i.test(a.split('=')[0]) && /^-/.test(a)) {
      if (a.includes('=')) { out.push('<redacted>'); continue; }
      out.push(a);
      if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('-')) {
        out.push('<redacted>');
        i += 1;
      }
      continue;
    }
    out.push(/key|secret|token|password/i.test(a.split('=')[0]) ? '<redacted>' : argv[i]);
  }
  return out;
}

function hashFileSha256(abs, maxBytes = 256 * 1024 * 1024) {
  const data = readFileSync(abs);
  if (data.length > maxBytes) throw harnessError(`refusing to hash oversized file: ${abs}`);
  return { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

// Real-run proposal: ONLY the pinned engine/GGUF, exact argv set, tight
// bounds (max 32 output tokens, one short prompt, ≤60s request deadline,
// ≤300s owned-process lifetime). `pins` is injectable for hermetic tests;
// the operator path always uses PINNED_ASSETS.
export function buildProposal(params, { candidateRevOverride = null, pins = PINNED_ASSETS } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!params || typeof params !== 'object') return fail('proposal must be an object');
  const allowed = ['model_id', 'runtime_id', 'endpoint', 'max_tokens', 'deadline_s',
    'prompt', 'max_lifetime_s', 'engine', 'gguf'];
  for (const k of Object.keys(params)) if (!allowed.includes(k)) return fail(`unsupported proposal field: ${k}`);
  const { model_id, runtime_id, endpoint, max_tokens, deadline_s, prompt, max_lifetime_s, engine, gguf } = params;
  if (typeof model_id !== 'string' || !model_id || model_id.length > 256) return fail('model_id must be 1..256 chars');
  if (!REAL_RUNTIMES.includes(runtime_id)) return fail('runtime_id must be one of: ganglion, llama-server');
  if (!Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > 32) return fail('real-run max_tokens must be 1..32');
  if (deadline_s !== 30 && deadline_s !== 60) return fail('real-run deadline_s must be 30 or 60 (UI-expressible within the ≤60s bound)');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500 || /[\r\n]/.test(prompt)) {
    return fail('real-run prompt must be one simple line, 1..500 chars');
  }
  if (!Number.isSafeInteger(max_lifetime_s) || max_lifetime_s < 1 || max_lifetime_s > 300) {
    return fail('real-run max_lifetime_s must be 1..300');
  }
  let url;
  try { url = new URL(endpoint); } catch { return fail('endpoint must be a URL'); }
  if (!isLoopbackHttp(url)) return fail('endpoint must be loopback http://127.0.0.1:port with no userinfo/query');
  if (!engine || typeof engine !== 'object' || typeof engine.path !== 'string' || !Array.isArray(engine.argv)) {
    return fail('engine.path (string) + engine.argv (array) required');
  }
  if (engine.path !== pins.engine.path) return fail('engine.path must be the pinned llama-server path');
  let engineHash;
  try { engineHash = hashFileSha256(engine.path); } catch { return fail('engine binary unreadable'); }
  if (engineHash.bytes !== pins.engine.bytes || engineHash.sha256 !== pins.engine.sha256.toLowerCase()) {
    return fail('engine binary does not match pinned bytes/hash');
  }
  // No arbitrary argv: exactly the pinned flag set with cross-checked values.
  const expectedArgv = ['-m', pins.gguf.path, '--port', String(url.port), '--alias', model_id, '--n-gpu-layers', '0'];
  if (engine.argv.length !== expectedArgv.length || !engine.argv.every((a, i) => a === expectedArgv[i])) {
    return fail('engine.argv must be exactly the pinned argv (model/port/alias/n-gpu-layers 0); nothing else');
  }
  if (!gguf || typeof gguf !== 'object' || gguf.path !== pins.gguf.path) return fail('gguf.path must be the pinned GGUF path');
  let ggufHash;
  try { ggufHash = hashFileSha256(gguf.path); } catch { return fail('gguf unreadable'); }
  if (ggufHash.bytes !== pins.gguf.bytes || ggufHash.sha256 !== pins.gguf.sha256.toLowerCase()) {
    return fail('gguf does not match pinned bytes/hash');
  }
  const proposal = { schema: REAL_PROPOSAL_SCHEMA, candidate_rev: candidateRevOverride || candidateRev(),
    created_at: new Date().toISOString(), model_id, runtime_id, endpoint,
    max_tokens, deadline_s, prompt, max_lifetime_s,
    engine: { path: engine.path, bytes: engineHash.bytes, sha256: engineHash.sha256, argv: engine.argv },
    gguf: { path: gguf.path, bytes: ggufHash.bytes, sha256: ggufHash.sha256 } };
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
  return { ok: true, file: { proposal, sha256 } };
}

// F2: routed source dirs whose bytes the real run loads from disk. A
// tracked modification anywhere in the candidate, or an untracked file
// under one of these dirs (shadowing risk — e.g. an extra module on a
// loader path such as the worker cwd), fails exact-build admission.
// Ignored entries (node_modules and friends) are out of scope: the run
// needs its pinned dependency copy resolvable; that pin is recorded,
// not refused, by this gate.
export const CANDIDATE_SOURCE_DIRS = ['local-worker/', 'website/src/', 'website/scripts/',
  'website/tests/', 'website/migrations/', 'website/public/'];

// Parse `git status --porcelain` (v1) for exact-build admission. Refuses
// any tracked change (staged, unstaged, renamed, unmerged) and any
// untracked path under CANDIDATE_SOURCE_DIRS. Unverifiable (not a
// checkout, git missing) also refuses — fail closed, never assume clean.
// Read-only: never resets, cleans, or deletes anything.
export function checkCandidateClean({ root, runGit = null } = {}) {
  const run = runGit || ((args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }));
  let out;
  try {
    out = run(['status', '--porcelain'], root);
  } catch {
    return { ok: false, reason: 'candidate cleanliness unverifiable (git status failed — not a checkout?)' };
  }
  const tracked = [];
  const shadow = [];
  for (const rawLine of String(out).split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3);
    if (code === '??') {
      // Porcelain double-quotes unusual paths; strip one quote layer for
      // the prefix test (quoted tracked lines refuse regardless).
      const probe = p.startsWith('"') ? p.slice(1) : p;
      if (CANDIDATE_SOURCE_DIRS.some((d) => probe === d || probe.startsWith(d))) shadow.push(p);
      continue;
    }
    if (code === '!!') continue;
    tracked.push(p);
  }
  const shown = (arr) => arr.slice(0, 3).map((p) => p.slice(0, 80)).join(', ')
    + (arr.length > 3 ? ` (+${arr.length - 3} more)` : '');
  if (tracked.length) {
    return { ok: false, reason: `candidate tree is dirty: ${tracked.length} tracked change(s) (${shown(tracked)})` };
  }
  if (shadow.length) {
    return { ok: false, reason: `untracked source-shadow candidates under routed dirs (${shown(shadow)})` };
  }
  return { ok: true };
}

export function authorizeRealRun(fileObj, confirmSha256, { candidateRevOverride = null, consumed = false, pins = PINNED_ASSETS, sourceRoot = null, runGit = null } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!fileObj || typeof fileObj !== 'object' || !fileObj.proposal || typeof fileObj.sha256 !== 'string') {
    return fail('proposal file must be {proposal, sha256}');
  }
  if (consumed === true) return fail('proposal already consumed (single-use: one dispatch per proposal)');
  const recomputed = crypto.createHash('sha256').update(JSON.stringify(fileObj.proposal)).digest('hex');
  if (recomputed !== fileObj.sha256) return fail('proposal sha256 mismatch (file edited after proposal)');
  if (confirmSha256 !== fileObj.sha256) {
    return fail('operator confirmation missing: restate the proposal sha256 explicitly via --confirm-sha256');
  }
  if (fileObj.proposal.schema !== REAL_PROPOSAL_SCHEMA) return fail('unknown proposal schema');
  const { schema, candidate_rev, created_at, ...params } = fileObj.proposal;
  void schema; void created_at;
  const rebuilt = buildProposal(params, { candidateRevOverride: candidate_rev, pins });
  if (!rebuilt.ok) return fail(`proposal no longer valid: ${rebuilt.reason}`);
  const current = candidateRevOverride || candidateRev();
  if (fileObj.proposal.candidate_rev !== current) {
    return fail(`proposal pins ${fileObj.proposal.candidate_rev}, current tree is ${current} (exact-build required)`);
  }
  const clean = checkCandidateClean({ root: sourceRoot || LANE_ROOT, runGit });
  if (!clean.ok) return fail(`exact-build refused: ${clean.reason}`);
  return { ok: true, proposal: fileObj.proposal, source_clean: true };
}

// ---------- Real-mode worker CLI path (actual local worker, no harness post) ----------
// The worker half runs the CANDIDATE local-worker CLIs exactly as the 4d
// proof did: pairing.py pair + heartbeat-once, then inference_worker.py
// --once against a private temp store. The worker validates the
// envelope/binding, executes its real runtime adapter, and posts its own
// result. The harness NEVER posts a worker result in real mode; it only
// observes the settled row through the operator's read API. Dendrite
// resolves ONLY from candidate local-worker/vendor/eif (PYTHONPATH prepend
// + import-path assertion); a stale venv Dendrite is a refusal, never a
// silent fallback.
export const WORKER_DIRNAME = 'local-worker';
export const WORKER_VENDOR_DIR = 'vendor/eif';
export const WORKER_DENDRITE_INIT = 'vendor/eif/dendrite/__init__.py';
export const WORKER_PYTHON_BIN = 'python';
export const WORKER_LEDGER_NAME = 'jobs-started.json';
const PAIR_OK_RE = /paired: resource (\S+)/;
const BEAT_OK_RE = /heartbeat ok: usable=(\w+) at=(\S+)/;
const WORKER_POSTED_RE = /jobs: (\S+) (succeeded|failed)(?: posted|\s+\[([A-Z_]+)\])?/;

// Default worker-process runner: capture output, enforce a timeout kill.
// Tests inject a scripted fake; NOTHING here runs without the explicit gate.
export async function defaultRunWorkerProc(bin, args, { cwd, env, timeoutMs } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: String((e && e.message) || e).slice(0, 500), timedOut: false, spawnError: true });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-8192); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: String((e && e.message) || e).slice(0, 500), timedOut: false, spawnError: true });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

// Pins the worker half as carefully as the engine/model: candidate script
// hashes, interpreter identity, and dendrite import-path selection. Throws
// harnessError (a refusal, not a fallback) on anything unexpected.
export async function resolveWorkerProvenance({ root = ROOT, pythonBin = WORKER_PYTHON_BIN,
  runProc, timeoutMs = 30000 } = {}) {
  if (typeof runProc !== 'function') throw harnessError('worker provenance needs a process runner');
  const workerDir = path.join(root, WORKER_DIRNAME);
  const vendorDir = path.join(workerDir, WORKER_VENDOR_DIR);
  const need = (rel) => {
    const abs = path.join(workerDir, rel);
    if (!existsSync(abs)) throw harnessError(`worker provenance refused: candidate file missing: local-worker/${rel}`);
    return abs;
  };
  const pairing = need('pairing.py');
  const inference = need('inference_worker.py');
  const dendriteInit = need(WORKER_DENDRITE_INIT);
  const sha = (abs) => ({ bytes: readFileSync(abs).length, sha256: sha256File(abs) });
  const ver = await runProc(pythonBin,
    ['-c', 'import sys;print(sys.version.split()[0]);print(sys.executable)'],
    { cwd: workerDir, timeoutMs });
  if (!ver || ver.timedOut || ver.status !== 0) {
    throw harnessError('worker provenance refused: python interpreter probe failed');
  }
  const [pyVersion, pyExe] = String(ver.stdout || '').trim().split(/\r?\n/);
  if (!pyVersion || !pyExe) throw harnessError('worker provenance refused: python probe output unreadable');
  const pythonpath = process.env.PYTHONPATH
    ? vendorDir + path.delimiter + process.env.PYTHONPATH : vendorDir;
  const probe = await runProc(pythonBin, ['-c', 'import dendrite;print(dendrite.__file__)'],
    { cwd: workerDir, env: { ...process.env, PYTHONPATH: pythonpath }, timeoutMs });
  if (!probe || probe.timedOut || probe.status !== 0) {
    throw harnessError('worker provenance refused: candidate dendrite not importable (refusing stale-venv fallback)');
  }
  const resolved = String(probe.stdout || '').trim();
  const inside = resolved && resolved.toLowerCase().startsWith(vendorDir.toLowerCase() + path.sep);
  if (!inside) {
    throw harnessError(`worker provenance refused: dendrite resolved outside candidate vendor (${resolved.slice(0, 120)})`);
  }
  return { pythonBin, pythonVersion: pyVersion, pythonExecutable: pyExe, workerDir, vendorDir, pythonpath,
    scripts: { pairing: sha(pairing), inference_worker: sha(inference) },
    dendrite: { file: resolved, ...sha(dendriteInit) } };
}

// Smallest real-mode orchestration behind the explicit gate. NOT executed by
// the author: tests drive it through injected fake process/HTTP/browser
// seams only. Default deps are the real ones for a future approved run:
// worker provenance → one owned engine child (pinned argv) → /health +
// /v1/models checks → harness (real-pairing world) → REAL pairing CLI
// (pair + heartbeat-once) → ONE browser-issued admission/job (browser stays
// alive) → REAL inference_worker.py --once (validates envelope/binding,
// runs its adapter, posts its own result) → operator reconcile + browser
// settled-content match + screenshot → cleanup + sanitized receipt. The
// harness posts NOTHING in real mode. Any fault aborts with cleanup;
// unknown outcomes are NEVER posted and NEVER retried.
export async function executeRealRun({ proposalFile, confirmSha256, markerPath, harnessOpts = {},
    deps = {} } = {}) {
  const { spawnChild = null, engineRequest = null, issueBrowserDispatch = null, runWorkerProc = null,
    sleepMs = null, candidateRevOverride = null, pins = PINNED_ASSETS, assemblyRoot = null, runGit = null } = deps;
  // Candidate local-worker lives at the assembly (lane) root, the parent of
  // website/. Tests inject a fixture assembly; the operator path needs a
  // checkout with local-worker/ present (else an honest missing-file refusal).
  const workerRoot = assemblyRoot || path.resolve(ROOT, '..');
  const fail = (reason) => ({ ok: false, reason });
  let fileObj;
  try {
    fileObj = JSON.parse(readFileSync(proposalFile, 'utf8'));
  } catch {
    return fail(`cannot read proposal file: ${proposalFile}`);
  }
  const auth = authorizeRealRun(fileObj, confirmSha256, { candidateRevOverride, pins, sourceRoot: workerRoot, runGit });
  if (!auth.ok) return fail(auth.reason);
  const proposal = auth.proposal;
  // One-use persistent attempt marker, atomically created BEFORE invocation.
  try {
    writeFileSync(markerPath, JSON.stringify({ sha256: fileObj.sha256, at: new Date().toISOString() }), { flag: 'wx' });
  } catch {
    return fail(`attempt marker exists (single-use): ${markerPath}`);
  }
  const t0 = Date.now();
  const maxLifetimeMs = proposal.max_lifetime_s * 1000;
  const expired = () => Date.now() - t0 > maxLifetimeMs;
  const sleep = sleepMs || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const request = engineRequest || (async (method, url, body, timeoutMs) => {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  });
  const spawn = spawnChild || ((await import('node:child_process')).spawn);
  const runProc = runWorkerProc || defaultRunWorkerProc;
  const remainingMs = () => Math.max(0, maxLifetimeMs - (Date.now() - t0));
  const checkLifetime = (what) => {
    if (expired()) throw { __realAbort: true, reason: `owned lifetime exceeded before ${what} (no retry)` };
  };
  const abort = (reason) => { throw { __realAbort: true, reason }; };
  const outcome = { dispatched: false, harnessPosted: false, workerPosted: false,
    workerVerdict: null, engineCalls: 0, ledgerCount: null, usable: null };
  const workerCalls = [];
  let child = null;
  let harness = null;
  let browser = null;
  let workerDataDir = null;
  let provenance = null;
  let resourceId = null;
  let issuedKey = null;
  let settled = null;
  let shotTaken = false;
  let failureReason = null;
  let receiptPath = null;
  const earlyDir = mkdtempSync(path.join(os.tmpdir(), 'private-demo-real-'));
  const killChild = async () => {
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await sleep(100);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
    }
  };
  const closeBrowser = async () => {
    if (browser) {
      // Best-effort terminal UI capture on the failure path (success already
      // screenshotted); the browser stayed alive through the outcome either way.
      if (harness && !shotTaken && outcome.dispatched) {
        try { await browser.screenshot(path.join(harness.dir, 'real-terminal.png')); } catch { /* best effort */ }
      }
      try { await browser.close(); } catch { /* best effort */ }
      browser = null;
    }
  };
  const shredWorkerDir = () => {
    if (!workerDataDir) return;
    try {
      rmSync(workerDataDir, { recursive: true, force: true });
      outcome.workerDataRemoved = true;
    } catch (e) {
      outcome.workerDataRemoved = false;
      outcome.cleanupWarn = `worker datadir removal failed: ${String((e && e.message) || e).slice(0, 160)}`;
    }
    workerDataDir = null;
  };
  const runWorker = async (args, timeoutMs) => {
    const started = Date.now();
    const out = await runProc(provenance.pythonBin, args,
      { cwd: provenance.workerDir, env: { ...process.env, PYTHONPATH: provenance.pythonpath }, timeoutMs });
    workerCalls.push({ argv: sanitizeArgv([provenance.pythonBin, ...args]),
      status: out ? out.status : null, timed_out: !!(out && out.timedOut), ms: Date.now() - started,
      stdout_tail: String((out && out.stdout) || '').trim().slice(-500) });
    return out || { status: null, stdout: '', stderr: '', timedOut: true };
  };
  try {
    // 1. Worker provenance FIRST: refuse before any spawn when the worker
    // half cannot qualify (scripts/interpreter/dendrite selection).
    checkLifetime('worker provenance');
    try {
      provenance = await resolveWorkerProvenance({ root: workerRoot, runProc,
        timeoutMs: Math.min(30000, Math.max(1000, remainingMs())) });
    } catch (e) {
      abort(e && e.message ? e.message : String(e));
    }
    // 2. Owned engine child (pinned argv only — no other executable surface).
    checkLifetime('engine spawn');
    child = spawn(proposal.engine.path, proposal.engine.argv, { stdio: 'ignore', windowsHide: true });
    if (!child || typeof child.pid !== 'number') abort('engine spawn failed');
    // 3. Readiness: /health then /v1/models must list the alias, bounded.
    let healthy = false;
    const healthDeadline = Date.now() + Math.min(60000, maxLifetimeMs);
    while (Date.now() < healthDeadline && !expired()) {
      try {
        const r = await request('GET', `${proposal.endpoint}/health`, null, Math.min(5000, Math.max(1000, remainingMs())));
        if (r.status === 200) { healthy = true; break; }
      } catch { /* not ready yet */ }
      await sleep(500);
    }
    if (!healthy) abort('engine health never ok (bounded; no dispatch attempted)');
    outcome.engineCalls += 1;
    checkLifetime('engine models check');
    const models = await request('GET', `${proposal.endpoint}/v1/models`, null, Math.min(10000, Math.max(1000, remainingMs())));
    outcome.engineCalls += 1;
    const ids = models.json && Array.isArray(models.json.data) ? models.json.data.map((m) => m.id) : [];
    if (models.status !== 200 || !ids.includes(proposal.model_id)) {
      abort(`engine models do not list alias ${proposal.model_id} (no dispatch attempted)`);
    }
    // 4. Harness up (real handlers + operator-only world; the paired worker
    // CLI claims its own resource — no harness-held worker credential).
    checkLifetime('harness start');
    harness = await createHarness({ ...harnessOpts, mode: 'real-approved', worldSetup: 'real-pairing' });
    await harness.start();
    const opHeaders = { Cookie: harness.world.operator.cookie, 'X-Aipster-CSRF': '1' };
    // 5. REAL pairing CLI: mint a one-time code, claim it, heartbeat once.
    // (Same invocations as the 4d proof; failure text never carries the code.)
    checkLifetime('pairing code mint');
    const codeRes = await fetch(`${harness.baseUrl}/api/pairing/codes`, { method: 'POST',
      headers: { ...opHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlMinutes: 10 }),
      signal: AbortSignal.timeout(Math.min(15000, Math.max(1000, remainingMs()))) });
    const codeJson = await codeRes.json().catch(() => null);
    if (codeRes.status !== 201 || !codeJson || typeof codeJson.code !== 'string') {
      abort(`pairing code mint failed (status ${codeRes.status}, code ${codeJson && codeJson.code ? codeJson.code : 'none'})`);
    }
    workerDataDir = mkdtempSync(path.join(os.tmpdir(), 'fabric-harness-worker-'));
    checkLifetime('worker pair claim');
    const pair = await runWorker(['pairing.py', '--api-base', harness.baseUrl, '--data-dir', workerDataDir,
      'pair', '--code', codeJson.code, '--name', 'TEST-real-worker'],
      Math.min(60000, Math.max(1000, remainingMs())));
    const pairM = PAIR_OK_RE.exec(String(pair.stdout || ''));
    if (pair.timedOut || pair.status !== 0 || !pairM) {
      abort(`worker pair claim failed (exit ${pair.status}, timed_out ${!!pair.timedOut}): no resource, no dispatch`);
    }
    resourceId = pairM[1];
    checkLifetime('worker heartbeat');
    const beat = await runWorker(['pairing.py', '--data-dir', workerDataDir, 'heartbeat-once'],
      Math.min(60000, Math.max(1000, remainingMs())));
    const beatM = BEAT_OK_RE.exec(String(beat.stdout || ''));
    if (beat.timedOut || beat.status !== 0 || !beatM) {
      abort(`worker heartbeat failed (exit ${beat.status}, timed_out ${!!beat.timedOut}): resource not live, no dispatch`);
    }
    outcome.usable = beatM[1];
    // 6. ONE browser-issued admission/job (default: real CDP click flow).
    // The browser STAYS ALIVE through the settled content (handle below).
    checkLifetime('browser dispatch');
    const issue = issueBrowserDispatch || issueBrowserDispatchReal;
    browser = await issue({ harness, proposal, resourceId });
    if (!browser || typeof browser.idempotencyKey !== 'string' || !browser.idempotencyKey
      || typeof browser.waitForSettled !== 'function' || typeof browser.screenshot !== 'function'
      || typeof browser.close !== 'function') {
      abort('browser dispatch did not return a live keyed handle (no worker call made)');
    }
    issuedKey = browser.idempotencyKey;
    outcome.dispatched = true;
    // HOLD029: the issuer yields its retained key before admission/job
    // creation completes — wait for the queued job matching THIS key
    // before invoking the one-shot worker (bounded by remaining
    // lifetime; an unqueued key aborts with no worker invocation).
    checkLifetime('job readiness');
    const keyedJob = await waitForJobQueued(harness.DB, { idempotencyKey: issuedKey,
      timeoutMs: Math.min(15000, Math.max(1000, remainingMs())), intervalMs: 50 });
    if (!keyedJob.ready) {
      abort('browser-issued job never queued (admission refused or timed out): no worker invocation, no retry');
    }
    // 7. REAL worker run: inference_worker.py --once validates the
    // envelope/binding, executes its runtime adapter, and posts its own
    // result. The harness posts NOTHING here — observe only.
    checkLifetime('worker run');
    const workerTimeout = Math.min(proposal.deadline_s * 1000, Math.max(1000, remainingMs()));
    const run = await runWorker(['inference_worker.py', '--data-dir', workerDataDir, '--once',
      '--runtime-id', proposal.runtime_id, '--ganglion-base', proposal.endpoint], workerTimeout);
    const postedM = WORKER_POSTED_RE.exec(`${run.stdout || ''}\n${run.stderr || ''}`);
    if (run.timedOut) abort('worker run exceeded its deadline (unknown outcome: nothing harness-posted, no retry)');
    if (run.status !== 0 || !postedM) {
      abort(`worker did not post a result (exit ${run.status}): unknown outcome, no retry`);
    }
    if (postedM[2] !== 'succeeded') {
      abort(`worker reported its run failed (${postedM[3] || 'no reason code'}): no retry`);
    }
    // 8. Reconcile by READING the harness-owned dispatch rows — never the
    // settle API. The browser's own poll must be the one that settles and
    // releases (a harness-side settle would steal the release and the UI
    // would show withheld instead of content). The worker-posted row must
    // be terminal-succeeded for THIS dispatch with content to release.
    checkLifetime('reconcile');
    const opCount = await harness.DB.prepare('SELECT COUNT(*) n FROM dispatch_operations').first('n');
    if (Number(opCount) !== 1) abort(`ANOMALY: dispatch_operations holds ${opCount} rows (want exactly this dispatch)`);
    const op = await harness.DB.prepare(
      'SELECT op_id, op_key, job_id, phase FROM dispatch_operations').first();
    if (!op || op.job_id !== postedM[1]
      || typeof op.op_key !== 'string' || !op.op_key.includes(JSON.stringify(issuedKey))) {
      abort(`ANOMALY: worker posted for job ${postedM[1].slice(0, 18)} but the recorded operation shows ${op && op.job_id ? op.job_id.slice(0, 18) : 'none'}`);
    }
    const row = await harness.DB.prepare(
      'SELECT job_id, status, result_json, resource_id, runtime_instance, model_fingerprint FROM dispatch_jobs WHERE job_id = ?'
    ).bind(postedM[1]).first();
    if (!row) abort(`ANOMALY: worker posted for job ${postedM[1].slice(0, 18)} but no such dispatch row exists`);
    let posted = null;
    try { posted = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* treated as missing */ }
    if (row.status !== 'succeeded' || !posted || typeof posted.content !== 'string' || !posted.content.trim()) {
      abort(`worker-posted row not terminal-succeeded with content (status ${row.status}): no retry`);
    }
    if (row.resource_id !== resourceId) {
      abort(`ANOMALY: worker-posted row targets resource ${row.resource_id} (want the paired ${resourceId})`);
    }
    if (posted.runtime_instance !== row.runtime_instance || posted.model_fingerprint !== row.model_fingerprint) {
      abort('ANOMALY: posted result does not echo the admitted binding (runtime_instance/model_fingerprint)');
    }
    outcome.workerPosted = true;
    outcome.workerVerdict = 'succeeded';
    settled = { job_id: row.job_id, content: posted.content, op_phase: op.phase,
      provenance: { node_id: posted.node_id, runtime_id: posted.runtime_id, model_id: posted.model_id,
        runtime_instance: posted.runtime_instance, model_fingerprint: posted.model_fingerprint,
        simulated: posted.simulated } };
    // 9. Visible result: the live browser must show the settled content and
    // it must EXACTLY match the worker-posted row. Then screenshot.
    checkLifetime('browser settled display');
    let shown;
    try {
      shown = await browser.waitForSettled(Math.min(60000, Math.max(1000, remainingMs())));
    } catch {
      abort('browser never showed settled real content within the owned lifetime (no retry)');
    }
    if (!shown || typeof shown.statusText !== 'string'
      || !shown.statusText.includes('Settled: content released')) {
      abort('browser settled state unreadable (anomaly: API settled, UI did not)');
    }
    if (shown.content !== settled.content) {
      abort('browser shows different content than the settled worker-posted row (anomaly)');
    }
    settled.uiProvenance = typeof shown.provenance === 'string' ? shown.provenance : '';
    try {
      await browser.screenshot(path.join(harness.dir, 'real-settled.png'));
      shotTaken = true;
    } catch {
      abort('settled screenshot capture failed (visible-result evidence missing)');
    }
    // 10. Exactly-one-execution proof: the worker's own started ledger.
    checkLifetime('ledger verification');
    let ledgerIds = null;
    try {
      const raw = JSON.parse(readFileSync(path.join(workerDataDir, WORKER_LEDGER_NAME), 'utf8'));
      ledgerIds = raw && Array.isArray(raw.job_ids) ? raw.job_ids : null;
    } catch { /* treated as missing below */ }
    if (!ledgerIds || ledgerIds.length !== 1 || ledgerIds[0] !== settled.job_id) {
      abort(`worker started-ledger shows ${ledgerIds ? ledgerIds.length : 'no'} executions (want exactly this job)`);
    }
    outcome.ledgerCount = 1;
    shredWorkerDir();
  } catch (e) {
    failureReason = e && e.__realAbort ? e.reason : `internal error: ${String((e && e.message) || e).slice(0, 300)}`;
  } finally {
    await killChild();
    await closeBrowser();
    shredWorkerDir();
    const finalExtra = { mode: 'real-approved', proposal_sha256: fileObj.sha256,
      engine: { argv: sanitizeArgv(proposal.engine.argv), bytes: proposal.engine.bytes, sha256: proposal.engine.sha256 },
      gguf: { bytes: proposal.gguf.bytes, sha256: proposal.gguf.sha256 },
      worker: provenance ? { python_version: provenance.pythonVersion,
        python_executable: provenance.pythonExecutable, scripts: provenance.scripts,
        dendrite: provenance.dendrite, calls: workerCalls } : null,
      resource_id: resourceId, outcome, settled,
      ...(failureReason ? { failure: failureReason } : {}) };
    if (harness) {
      try { receiptPath = await harness.stop(finalExtra); } catch { /* best effort */ }
    } else {
      // Pre-harness failure (provenance/engine/models): the marker alone is
      // not a receipt — write a minimal one so failures are always retained.
      try {
        receiptPath = path.join(earlyDir, 'receipt.json');
        writeFileSync(receiptPath, JSON.stringify(stripSecrets({ harness: 'private-inference-demo/v1',
          candidate_rev: candidateRevOverride || candidateRev(), base_url: null,
          stopped_at: new Date().toISOString(), ...finalExtra }), null, 2));
      } catch { /* best effort */ }
    }
  }
  if (!failureReason) return { ok: true, receipt: receiptPath, idempotencyKey: issuedKey };
  return { ok: false, reason: failureReason, receipt: receiptPath };
}

// Default browser issuer for a future approved run: real CDP click flow
// through the served UI (cookie stays in-process; never logged). Returns a
// LIVE handle — the browser stays open through the settled real content and
// the orchestrator closes it after the screenshot. Separated for injection
// in tests.
export async function issueBrowserDispatchReal({ harness, proposal, resourceId, cdpPort = 19333, driverPath = null } = {}) {
  if (!resourceId) throw harnessError('real-mode browser dispatch needs the paired resource id');
  const driverFile = driverPath || 'C:\\Users\\NM2\\Documents\\Codex\\2026-10-30\\task-4\\goose-evidence\\dashboard-preview-20261102-7007d08\\cdp-preview.mjs';
  if (!existsSync(driverFile)) throw harnessError('real-mode CDP driver missing (read-only prerequisite)');
  const driver = await import(pathToFileURL(driverFile).href);
  const api = await driver.launch({ cdpPort, width: 1280, height: 800 });
  let closed = false;
  const close = async () => {
    if (!closed) { closed = true; try { await api.close(); } catch { /* best effort */ } }
  };
  try {
    const cookie = harness.world.operator.cookie;
    const eq = cookie.indexOf('=');
    await api.raw('Network.enable');
    await api.raw('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), domain: '127.0.0.1', path: '/' });
    await api.navigate(`${harness.baseUrl}/app/experiments/inference-demo/`);
    await api.waitFor(`document.getElementById('session-state').textContent.includes('Signed in as')`, 15000);
    // Explicit paired resource via the manual field (the server validates
    // ownership and liveness at admission time); read back every field.
    await api.eval(`document.getElementById('manual-toggle').click()`);
    await api.eval(`document.getElementById('resource-manual').focus()`);
    await api.raw('Input.insertText', { text: resourceId });
    await api.eval(`document.getElementById('model-input').focus()`);
    await api.raw('Input.insertText', { text: proposal.model_id });
    await api.eval(`document.getElementById('prompt-input').focus()`);
    await api.raw('Input.insertText', { text: proposal.prompt });
    await api.eval(`document.getElementById('tokens-input').value = ${JSON.stringify(String(proposal.max_tokens))}`);
    await api.eval(`document.getElementById('deadline-select').value = ${JSON.stringify(String(proposal.deadline_s))}`);
    await api.eval(`document.getElementById('runtime-select').value = ${JSON.stringify(proposal.runtime_id)}`);
    const readback = await api.eval(`JSON.stringify({ manual: document.getElementById('manual-toggle').checked,
      resource: document.getElementById('resource-manual').value, model: document.getElementById('model-input').value,
      prompt: document.getElementById('prompt-input').value, tokens: document.getElementById('tokens-input').value,
      deadline: document.getElementById('deadline-select').value, runtime: document.getElementById('runtime-select').value })`);
    const rb = JSON.parse(readback);
    if (rb.manual !== true || rb.resource !== resourceId || rb.model !== proposal.model_id
      || rb.prompt !== proposal.prompt || rb.tokens !== String(proposal.max_tokens)
      || rb.deadline !== String(proposal.deadline_s) || rb.runtime !== proposal.runtime_id) {
      throw harnessError('browser field readback mismatch (refusing to submit ambiguous inputs)');
    }
    await api.click('#submit-btn');
    await api.waitFor(`document.getElementById('key-line').textContent.length > 0`, 15000);
    const keyLine = await api.eval(`document.getElementById('key-line').textContent`);
    const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(keyLine);
    if (!m) throw harnessError('browser dispatch issued but key line unreadable');
    return { idempotencyKey: m[0],
      async waitForSettled(timeoutMs) {
        await api.waitFor(`document.getElementById('status-line').textContent.includes('Settled: content released')`, timeoutMs);
        const statusText = await api.eval(`document.getElementById('status-line').textContent`);
        const content = await api.eval(`document.getElementById('result-pre').textContent`);
        const provenance = await api.eval(`document.getElementById('provenance-line').textContent`);
        return { statusText, content, provenance };
      },
      async screenshot(file) { await api.shot(file); },
      close };
  } catch (e) {
    await close();
    throw e;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'serve';
  if (cmd === 'serve') {
    const h = await createHarness({
      port: args.port !== undefined ? Number(args.port) : DEFAULT_PORT,
      dbPath: args.memory ? null : (args.db || path.join(mkdtempSync(path.join(os.tmpdir(), 'private-demo-db-')), 'demo.sqlite')),
      ownerTokens: args['owner-tokens'] || DEFAULT_OWNER_TOKENS,
      receiptDir: args['receipt-dir'] || null,
      log: (m) => process.stderr.write(m + '\n'),
    });
    await h.start();
    process.stdout.write(`private demo harness up: ${h.baseUrl}\nTEST identity: ${h.world.operator.id} (synthetic, not GitHub OAuth)\nTEST resource: ${h.world.resourceId}\nreceipt: ${path.join(h.dir, 'receipt.json')}\n`);
    const shutdown = async () => {
      const receipt = await h.stop();
      process.stdout.write(`stopped. receipt: ${receipt}\n`);
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    await new Promise(() => {});
  }
  if (cmd === 'propose-real') {
    const params = {
      model_id: args.model, runtime_id: args.runtime, endpoint: args.endpoint,
      max_tokens: Number(args['max-tokens']), deadline_s: Number(args['deadline-s']),
      prompt: args.prompt, max_lifetime_s: Number(args['max-lifetime-s'] || 300),
      engine: { path: args['engine-path'], argv: JSON.parse(readFileSync(args['engine-argv-json'], 'utf8')) },
      gguf: { path: args['gguf-path'] },
    };
    const built = buildProposal(params, {});
    if (!built.ok) {
      process.stderr.write(`proposal refused: ${built.reason}\n`);
      process.exitCode = 2;
      return;
    }
    const out = args.out || path.join(process.cwd(), 'real-proposal.json');
    writeFileSync(out, JSON.stringify(built.file, null, 2));
    process.stdout.write(`proposal written: ${out}\nsha256: ${built.file.sha256}\n(restates via --confirm-sha256 to authorize; nothing executed)\n`);
    return;
  }
  if (cmd === 'run-real') {
    const markerPath = args.marker || `${args.proposal}.attempted`;
    if (existsSync(markerPath)) {
      process.stderr.write(`real run refused: attempt marker exists (single-use): ${markerPath}\n`);
      process.exitCode = 2;
      return;
    }
    const out = await executeRealRun({ proposalFile: args.proposal, confirmSha256: args['confirm-sha256'],
      markerPath, harnessOpts: { port: args.port !== undefined ? Number(args.port) : 18736,
        receiptDir: args['receipt-dir'] || null },
      deps: args['assembly-root'] ? { assemblyRoot: args['assembly-root'] } : {} });
    if (!out.ok) {
      process.stderr.write(`real run refused/failed: ${out.reason}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`real run settled: key=${out.idempotencyKey}\nreceipt: ${out.receipt}\n`);
    return;
  }
  process.stderr.write('usage: private-inference-demo.mjs [serve|propose-real|run-real] [options]\n');
  process.exitCode = 2;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(String((e && e.message) || e) + '\n');
    process.exitCode = 1;
  });
}
