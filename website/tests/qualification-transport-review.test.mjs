/* Independent verification lane: worker HTTP transport review on REAL D1.
 * Isolated Miniflare (workerd) D1 + the ACTUAL worker.js fetch transport:
 * every check below goes through real route wiring (session/CSRF gates,
 * flag gate, heartbeat-key scope). Synthetic non-demo owners + one
 * synthetic resource-bound heartbeat test key; nothing persists (DB
 * disposed after). Fixtures only: no provider calls, no keys, no live mode.
 * Covers auth/CSRF/heartbeat entrypoints; does NOT duplicate the author's
 * handler-level admission/spend/cache/lease unit checks in
 * qualification-d1.test.mjs. Owned by verification lane. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_FILES, signSessionCookie, TEST_SECRET } from './d1-shim.mjs';
import { mintKey, verifierFor } from '../src/lib/keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:8787';
let mf = null;
let db = null;
let worker = null;

const baseEnv = () => ({
  DB: db,
  BETTER_AUTH_SECRET: TEST_SECRET,
  BETTER_AUTH_URL: BASE,
  QUALIFICATION_ENABLED: '1',
  ASSETS: { fetch: async () => new Response('asset missing', { status: 404 }) },
});

async function call(pathname, { method = 'GET', headers = {}, body } = {}, envOver = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await worker.default.fetch(new Request(BASE + pathname, init), { ...baseEnv(), ...envOver });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

let aliceCookie = '';
const csrf = { 'X-Aipster-CSRF': '1' };
const asAlice = () => ({ Cookie: aliceCookie, ...csrf });
const asBob = () => ({ Cookie: bobCookie, ...csrf });
let bobCookie = '';
let hb = {};
let hb2 = {};

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'qual-transport-test' },
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
  const seedUser = async (id, email) => {
    await db.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind(email, now).run();
    await db.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, id, email, 1, null, now, now).run();
    const token = randomBytes(32).toString('hex');
    await db.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('s_' + token.slice(0, 8), new Date(Date.now() + 12 * 3600 * 1000).toISOString(), token, now, now, null, 'test', id).run();
    return `better-auth.session_token=${signSessionCookie(token, TEST_SECRET)}`;
  };
  aliceCookie = await seedUser('u_alice', 'alice@x.invalid');
  bobCookie = await seedUser('u_bob', 'bob@x.invalid');
  const seedNode = async (id, mem) => {
    await db.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, 'u_alice', `n-${id}`, 'node', 'test', 'x', 'none', now).run();
    await db.prepare('INSERT INTO node_capabilities (node_id, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, now, 'linux', 'x86_64', JSON.stringify([{ name: 'ganglion', models: ['m'] }]), JSON.stringify({ ramTotalBytes: mem }), '{}', '{}').run();
  };
  await seedNode('r_hw', 8 * 1024 ** 3);
  await seedNode('r_hw2', 9 * 1024 ** 3);
  const mintHb = async (name, nodeId) => {
    const minted = mintKey();
    const salt = randomBytes(16).toString('hex');
    await db.prepare(
      'INSERT INTO key_verifiers (id, owner_id, name, scope, resource_id, salt, verifier, prefix, expires_at, metadata, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
    ).bind(minted.id, 'u_alice', name, 'heartbeat', nodeId, salt, await verifierFor(minted.secret, salt), 'aip_live_' + minted.id, null, 'harness synthetic', now).run();
    return { Authorization: `Bearer ${minted.secret}` };
  };
  hb = await mintHb('harness-hb', 'r_hw');
  hb2 = await mintHb('harness-hb2', 'r_hw2');
  worker = await import(`../src/worker.js?transport-review-${randomBytes(4).toString('hex')}`);
});

after(async () => { await mf.dispose(); });

const goodResult = (leaseId) => ({
  leaseId, status: 'succeeded',
  result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 900, promptTokens: 8, completionTokens: 32 },
});

test('transport: anonymous gets 401, flag-off gets 404', async () => {
  const anon = await call('/api/qualifications');
  assert.equal(anon.status, 401);
  const off = await call('/api/qualifications', { headers: { Cookie: aliceCookie } }, { QUALIFICATION_ENABLED: undefined });
  assert.equal(off.status, 404);
});

test('transport: quota enforced over HTTP on distinct identities', async () => {
  const env = { QUAL_OWNER_PER_HOUR: '1', QUAL_GLOBAL_PER_HOUR: '100' };
  const a = await call('/api/resources/r_hw/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't-cap-1' } }, env);
  assert.equal(a.status, 200);
  await db.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: Math.floor(8.5 * 1024 ** 3) }), 'r_hw').run();
  const b = await call('/api/resources/r_hw/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't-cap-2' } }, env);
  assert.equal(b.status, 429);
  const drain = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(drain.status, 409);
});

test('transport: owner POST needs CSRF; happy path is 200 fixture', async () => {
  const noCsrf = await call('/api/resources/r_hw/qualification', {
    method: 'POST', headers: { Cookie: aliceCookie }, body: { opKey: 't0' },
  });
  assert.equal(noCsrf.status, 403);
  const ok = await call('/api/resources/r_hw/qualification', {
    method: 'POST', headers: asAlice(), body: { opKey: 't1' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json?.receipt?.mode, 'fixture');
  assert.ok(ok.json?.assignment?.lease_id);
});

test('transport: report is owner-scoped, cross-owner denied', async () => {
  const bobPost = await call('/api/resources/r_hw/qualification', {
    method: 'POST', headers: asBob(), body: { opKey: 'tb' },
  });
  assert.equal(bobPost.status, 404);
  const seen = await call('/api/qualifications', { headers: { Cookie: bobCookie } });
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.json?.recommendations ?? null, []);
});

test('transport: worker lease cycle over heartbeat key', async () => {
  const next = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(next.status, 200);
  assert.ok(next.json?.leaseId);
  const idle = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(idle.status, 204);
  const sess = await call('/api/worker/qualifications/next', { headers: { Cookie: aliceCookie } });
  assert.equal(sess.status, 403);
  const anon = await call('/api/worker/qualifications/next');
  assert.equal(anon.status, 403);
  return next.json;
});

test('transport: result binding, replay, and unleased refusal', async () => {
  const next = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(next.status, 204);
  const post = await call('/api/resources/r_hw2/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't2' } });
  assert.equal(post.status, 200);
  const run = post.json.assignment.run_id;
  const lease = post.json.assignment.lease_id;
  const leased = await call('/api/worker/qualifications/next', { headers: hb2 });
  assert.equal(leased.status, 200);
  assert.equal(leased.json?.runId, run);
  const wrong = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb2, body: { ...goodResult(lease), leaseId: 'qlease_nope' } });
  assert.equal(wrong.status, 403);
  const crossNode = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb, body: goodResult(lease) });
  assert.equal(crossNode.status, 404);
  const done = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb2, body: goodResult(lease) });
  assert.equal(done.status, 200);
  assert.equal(done.json?.state, 'succeeded');
  const dup = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb2, body: goodResult(lease) });
  assert.equal(dup.json?.replay, true);
  await db.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 14 * 1024 ** 3 }), 'r_hw2').run();
  const pm = await call('/api/resources/r_hw2/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't-model' } });
  assert.equal(pm.status, 200);
  const runm = pm.json.assignment.run_id;
  const leasem = pm.json.assignment.lease_id;
  const nxm = await call('/api/worker/qualifications/next', { headers: hb2 });
  assert.equal(nxm.status, 200);
  assert.equal(nxm.json?.runId, runm);
  const mismatch = await call(`/api/worker/qualifications/${runm}/result`, { method: 'POST', headers: hb2, body: { ...goodResult(leasem), result: { ...goodResult(leasem).result, modelId: 'other-model' } } });
  assert.equal(mismatch.status, 403);
  const post3 = await call('/api/resources/r_hw2/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't3-cache' } });
  assert.equal(post3.json?.cached, true);
  await db.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 13 * 1024 ** 3 }), 'r_hw2').run();
  const pu = await call('/api/resources/r_hw2/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't-unleased' } });
  assert.equal(pu.status, 200);
  const unleased = await call(`/api/worker/qualifications/${pu.json.assignment.run_id}/result`, { method: 'POST', headers: hb2, body: goodResult(pu.json.assignment.lease_id) });
  assert.equal(unleased.status, 409);
});

test('transport: stale profile and late result are retained uncertain', async () => {
  await db.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 20 * 1024 ** 3 }), 'r_hw').run();
  const post = await call('/api/resources/r_hw/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't4' } });
  assert.equal(post.status, 200);
  assert.equal(post.json?.cached, undefined);
  const run = post.json.assignment.run_id;
  const lease = post.json.assignment.lease_id;
  await db.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 21 * 1024 ** 3 }), 'r_hw').run();
  const stale = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(stale.status, 409);
  const staleRes = await call(`/api/worker/qualifications/${run}/result`, { method: 'POST', headers: hb, body: goodResult(lease) });
  assert.equal(staleRes.status, 409);
  await db.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 22 * 1024 ** 3 }), 'r_hw').run();
  const p5 = await call('/api/resources/r_hw/qualification', { method: 'POST', headers: asAlice(), body: { opKey: 't5' } });
  assert.equal(p5.status, 200);
  const run5 = p5.json.assignment.run_id;
  const lease5 = p5.json.assignment.lease_id;
  const nx = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(nx.status, 200);
  assert.equal(nx.json?.runId, run5);
  await db.prepare('UPDATE qualification_runs SET execution_deadline = ? WHERE run_id = ?')
    .bind(new Date(Date.now() - 3600e3).toISOString(), run5).run();
  const late = await call(`/api/worker/qualifications/${run5}/result`, { method: 'POST', headers: hb, body: goodResult(lease5) });
  assert.equal(late.status, 409);
});

test('transport: revocation and ownership transfer close worker access', async () => {
  const now = new Date().toISOString();
  const row = await db.prepare('SELECT id FROM key_verifiers WHERE resource_id = ? AND revoked_at IS NULL').bind('r_hw').first();
  await db.prepare('UPDATE key_verifiers SET revoked_at = ? WHERE id = ?').bind(now, row.id).run();
  const refused = await call('/api/worker/qualifications/next', { headers: hb });
  assert.ok([401, 403].includes(refused.status), `revoked status ${refused.status}`);
  await db.prepare('UPDATE key_verifiers SET revoked_at = NULL WHERE id = ?').bind(row.id).run();
  await db.prepare('UPDATE resources SET owner_id = ? WHERE id = ?').bind('u_bob', 'r_hw').run();
  const old = await call('/api/qualifications', { headers: { Cookie: aliceCookie } });
  assert.ok(!(old.json?.recommendations || []).some((x) => x.node_id === 'r_hw'));
  const keyOld = await call('/api/worker/qualifications/next', { headers: hb });
  assert.equal(keyOld.status, 404);
});
