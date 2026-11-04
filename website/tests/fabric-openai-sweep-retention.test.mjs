/* FABRIC104 finding 2: settled results must survive the admission sweep.
 *
 * REAL store (node:sqlite + migrations + d1-shim) with an actual sweep:
 * settle an op, advance past the 10-minute admission TTL, trigger a fresh
 * issueAdmission (which runs the DELETE sweep), then GET + same POST replay.
 * Covers: post-sweep GET/replay, revoked authority, other-user isolation,
 * payload-mismatch conflict, pending behavior, and no-new-dispatch counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const W = new URL('.', import.meta.url).pathname.replace(/\/tests\/$/, '');
const { applyMigrations, createD1Shim } = await import(W + '/tests/d1-shim.mjs');
const { createD1DispatchStore } = await import(W + '/src/inference/dispatch-store.mjs');
const { createFabricOpenAIRoute } = await import(W + '/src/inference/fabric-openai-route.mjs');

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network forbidden'); };

const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const BODY = { model: 'synth-model-a', messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 16 };

function setup({ stepWorker = true } = {}) {
  let t = T0;
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  sqlite.prepare(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, demo)
    VALUES ('u_alice', 'Alice', 'alice@example.com', 1, NULL, ?, ?, 0),
           ('u_bob', 'Bob', 'bob@example.com', 1, NULL, ?, ?, 0)`)
    .run(iso(T0 - 3600000), iso(T0 - 3600000), iso(T0 - 3600000), iso(T0 - 3600000));
  sqlite.prepare(`INSERT INTO resources
    (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated,
     online, usable, heartbeat_at, limits_json, scope, verification_json, created_at, node_id, incarnation)
    VALUES ('res-A', 'u_alice', 'res-A', 'local', 'synthetic', 'x86', 'none', '[]', 1, 1, 1, 1, ?, '{}',
      'owner only', '{}', ?, 'node-A', 'inc-A')`).run(iso(T0 - 1000), iso(T0 - 3600000));
  sqlite.prepare(`INSERT INTO node_capabilities
    (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json)
    VALUES ('res-A', 1, ?, 'synthetic-os', 'synthetic-arch', ?, '{}', '{}', '{}')`)
    .run(iso(T0 - 2000), JSON.stringify([{ name: 'ganglion', models: ['synth-model-a'] }]));
  const db = createD1Shim(sqlite);
  const store = createD1DispatchStore(db, { now: () => t, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000' } });
  const workerStep = async () => {
    const lease = await store.leaseNextJob({ resource_id: 'res-A', now: t }).catch(() => null);
    if (!lease) return;
    const env = lease.envelope;
    await store.completeJob({ job_id: lease.job_id, lease_id: lease.lease_id, resource_id: 'res-A',
      status: 'succeeded',
      result: { request_id: lease.job_id, node_id: env.task.placement.node_id,
        runtime_id: env.task.placement.runtime_id, model_id: env.task.model_id,
        runtime_instance: env.binding.runtime_instance, model_fingerprint: env.binding.model_fingerprint,
        simulated: false, content: 'synthetic ok', elapsed_ms: 1, usage: {}, cache: {}, finish_reason: 'stop' } });
  };
  const makeRoute = (actor, maxWaitMs = 60000) => createFabricOpenAIRoute({
    needAuthz: () => null, actor, db, env: {}, getStore: async () => store, clock: () => t,
    sleep: async (ms) => { t += ms; if (stepWorker) await workerStep(); },
    generateKey: () => 'auto-op-key-00000001', maxWaitMs, pollIntervalMs: 10,
  });
  const counts = () => ({
    admissions: sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions').get().n,
    jobs: sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get().n,
  });
  const refreshLiveness = () => {
    sqlite.prepare('UPDATE node_capabilities SET reported_at = ? WHERE node_id = ?').run(iso(t - 2000), 'res-A');
    sqlite.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').run(iso(t - 1000), 'res-A');
  };
  return { sqlite, store, makeRoute, counts, refreshLiveness, get t() { return t; }, setT(v) { t = v; } };
}

test('settled op survives the admission sweep: GET 200 + same POST replay 200, no new dispatch', async () => {
  const h = setup();
  const route = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } });
  const first = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-sweep01a' });
  assert.equal(first.http, 200);
  h.setT(T0 + 11 * 60 * 1000);
  h.refreshLiveness();
  const sweep = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-sweep02b' });
  assert.equal(sweep.http, 200);
  const before = h.counts();
  const status = await route.handleStatus({ idempotencyKey: 'f2-op-sweep01a' });
  assert.equal(status.http, 200);
  assert.equal(status.body.choices[0].message.content, 'synthetic ok');
  assert.equal(status.body.provenance.path, 'fabric');
  assert.equal(status.body.provenance.simulated, false);
  const replay = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-sweep01a' });
  assert.equal(replay.http, 200);
  assert.equal(replay.body.choices[0].message.content, 'synthetic ok');
  assert.deepEqual(h.counts(), before, 'GET + replay create no admission or job');
});

test('revoked authority stays denied after the sweep', async () => {
  const h = setup();
  const route = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } });
  assert.equal((await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-revoke01a' })).http, 200);
  h.setT(T0 + 11 * 60 * 1000);
  h.refreshLiveness();
  assert.equal((await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-revoke02b' })).http, 200);
  h.sqlite.prepare("UPDATE resources SET owner_id = 'u_bob' WHERE id = 'res-A'").run();
  const status = await route.handleStatus({ idempotencyKey: 'f2-op-revoke01a' });
  assert.equal(status.http, 503);
  assert.ok(!JSON.stringify(status.body).includes('synthetic ok'), 'revoked authority leaks no content');
  const replay = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-revoke01a' });
  assert.equal(replay.http, 503);
  assert.ok(!JSON.stringify(replay.body).includes('synthetic ok'));
});

test('other user is denied the victim operation', async () => {
  const h = setup();
  const alice = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } });
  assert.equal((await alice.handleChat({ body: BODY, idempotencyKey: 'f2-op-other01a' })).http, 200);
  const victimJob = h.sqlite.prepare("SELECT job_id AS j FROM dispatch_jobs ORDER BY rowid DESC LIMIT 1").get().j;
  const bob = h.makeRoute({ kind: 'session', user: { id: 'u_bob' } });
  const status = await bob.handleStatus({ idempotencyKey: 'f2-op-other01a' });
  assert.notEqual(status.http, 200, 'no cross-user completion');
  assert.ok(!JSON.stringify(status.body || {}).includes(victimJob), 'no victim job correlation leaks');
});

test('mismatched payload replay is a conflict with no new job, even after sweep', async () => {
  const h = setup();
  const route = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } });
  assert.equal((await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-mismatch1a' })).http, 200);
  h.setT(T0 + 11 * 60 * 1000);
  h.refreshLiveness();
  assert.equal((await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-mismatch2b' })).http, 200);
  const jobsBefore = h.counts().jobs;
  const other = { model: 'synth-model-a', messages: [{ role: 'user', content: 'Different' }], max_tokens: 16 };
  const replay = await route.handleChat({ body: other, idempotencyKey: 'f2-op-mismatch1a' });
  assert.equal(replay.http, 409);
  assert.equal(replay.body.error.code, 'idempotency_conflict');
  assert.equal(h.counts().jobs, jobsBefore, 'mismatch creates no job');
});

test('pending op survives the sweep: uncertain with correlation, replay dispatches nothing new', async () => {
  const h = setup({ stepWorker: false });
  const route = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } });
  const short = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } }, 3000);
  const first = await short.handleChat({ body: BODY, idempotencyKey: 'f2-op-pending01' });
  assert.equal(first.http, 409, 'unsettled op answers pending');
  assert.ok(first.body.op_id && first.body.job_id, 'pending receipt carries correlation');
  h.setT(h.t + 11 * 60 * 1000);
  h.refreshLiveness();
  await h.store.issueAdmission({ principal: { principal_id: 'u_alice', tenant_id: 'u_alice' },
    resource_id: 'res-A', model_id: 'synth-model-a', max_tokens: 16 });
  const jobsAfterSweep = h.counts().jobs;
  // Deadline passed while the job was still running: the outcome is
  // genuinely uncertain. Correlation must survive; nothing new dispatches.
  const status = await route.handleStatus({ idempotencyKey: 'f2-op-pending01' });
  assert.equal(status.http, 503);
  assert.equal(status.body.error.code, 'outcome_uncertain');
  assert.equal(status.body.op_id, first.body.op_id);
  assert.equal(status.body.job_id, first.body.job_id);
  const replay = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-pending01' });
  assert.equal(replay.http, 503);
  assert.equal(replay.body.error.code, 'outcome_uncertain');
  assert.equal(h.counts().jobs, jobsAfterSweep, 'replay dispatches no new job');
});

test('validator refusal blocks swept-admission fallback on status and replay', async () => {
  const h = setup();
  const route = h.makeRoute({ kind: 'session', user: { id: 'u_alice' } });
  assert.equal((await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-tamper01a' })).http, 200);
  h.setT(T0 + 11 * 60 * 1000);
  h.refreshLiveness();
  assert.equal((await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-tamper02b' })).http, 200);
  const opKey = JSON.stringify(['u_alice', 'f2-op-tamper01a']);
  const readBinding = () => JSON.parse(h.sqlite.prepare('SELECT binding_json AS b FROM dispatch_operations WHERE op_key = ?').get(opKey).b);
  const writeBinding = (b) => h.sqlite.prepare('UPDATE dispatch_operations SET binding_json = ? WHERE op_key = ?').run(JSON.stringify(b), opKey);
  // Variant A: wrong principal/tenant — the store validator returns false.
  writeBinding({ ...readBinding(), principal_id: 'u_bob', tenant_id: 'u_bob' });
  const before = h.counts();
  const status = await route.handleStatus({ idempotencyKey: 'f2-op-tamper01a' });
  assert.equal(status.http, 503, 'tampered binding yields no completion');
  assert.ok(!JSON.stringify(status.body || {}).includes('synthetic ok'));
  const replay = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-tamper01a' });
  assert.equal(replay.http, 403);
  assert.equal(replay.body.error.code, 'admission_not_available');
  assert.deepEqual(h.counts(), before, 'refused replay creates no admission or job');
  // Variant B: malformed binding (identity field missing).
  const malformed = readBinding();
  delete malformed.model_id;
  writeBinding(malformed);
  assert.equal((await route.handleStatus({ idempotencyKey: 'f2-op-tamper01a' })).http, 503);
  const replay2 = await route.handleChat({ body: BODY, idempotencyKey: 'f2-op-tamper01a' });
  assert.equal(replay2.http, 403);
  assert.equal(replay2.body.error.code, 'admission_not_available');
});

test('teardown restores fetch', () => {
  globalThis.fetch = realFetch;
});
