// FABRIC067 real-store integration: REAL disposable D1 dispatch store
// (node:sqlite + repo migrations, no worker.js import) + REAL route with the
// DEFAULT candidate loader + a fixture worker that leases and completes
// clearly labeled synthetic jobs. No model is called, no network happens.
//
// Exercises two owner nodes with different resident models/runtimes, stale
// and unready evidence, unknown-model exclusion, wrong-owner isolation, and
// the post-transfer revoked-release path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, createD1Shim } from './d1-shim.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';
import { createFabricOpenAIRoute } from '../src/inference/fabric-openai-route.mjs';

const network = { fetch: 0, ws: 0, socket: 0 };
const realFetch = globalThis.fetch;
const realWs = globalThis.WebSocket;
const realConnect = net.Socket.prototype.connect;
globalThis.fetch = async () => { network.fetch += 1; throw new Error('network forbidden in d1 integration tests'); };
globalThis.WebSocket = class { constructor() { network.ws += 1; throw new Error('WebSocket forbidden'); } };
net.Socket.prototype.connect = function () { network.socket += 1; throw new Error('socket forbidden'); };
after(() => {
  globalThis.fetch = realFetch; globalThis.WebSocket = realWs; net.Socket.prototype.connect = realConnect;
});
const noNetwork = () => assert.deepEqual(network, { fetch: 0, ws: 0, socket: 0 });

const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const SYNTHETIC = 'synthetic-no-model completion';

function seed(sqlite, nowMs) {
  const created = iso(nowMs - 3600000);
  sqlite.prepare(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, demo)
    VALUES ('u_alice', 'Alice', 'alice@example.com', 1, NULL, ?, ?, 0)`)
    .run(created, created);
  const res = (id, node, inc, online, usable, hbAgeMs) => sqlite.prepare(`INSERT INTO resources
    (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated,
     online, usable, heartbeat_at, limits_json, scope, verification_json, created_at, node_id, incarnation)
    VALUES (?, 'u_alice', ?, 'local', 'synthetic', 'x86', 'none', '[]', 1, 1, ?, ?, ?, '{}',
      'owner only', '{}', ?, ?, ?)`).run(id, id, online, usable, iso(nowMs - hbAgeMs), iso(nowMs - 3600000), node, inc);
  res('res-A', 'node-A', 'inc-A', 1, 1, 1000);
  res('res-B', 'node-B', 'inc-B', 1, 1, 1000);
  res('res-stale', 'node-S', 'inc-S', 1, 1, 600000);
  res('res-down', 'node-D', 'inc-D', 1, 0, 1000);
  const cap = (node, ageMs, runtimes) => sqlite.prepare(`INSERT INTO node_capabilities
    (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json)
    VALUES (?, 1, ?, 'synthetic-os', 'synthetic-arch', ?, '{}', '{}', '{}')`)
    .run(node, iso(nowMs - ageMs), JSON.stringify(runtimes));
  cap('res-A', 2000, [{ name: 'ganglion', models: ['synth-model-a'] }]);
  cap('res-B', 3000, [{ name: 'llama-server', models: ['synth-model-b'] }]);
  cap('res-stale', 700000, [{ name: 'ganglion', models: ['synth-model-a'] }]);
  cap('res-down', 2000, [{ name: 'ganglion', models: ['synth-model-a'] }]);
}

function setup() {
  let t = T0;
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  seed(sqlite, T0);
  const db = createD1Shim(sqlite);
  const store = createD1DispatchStore(db, { now: () => t, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000' } });
  const actor = { kind: 'session', user: { id: 'u_alice' } };
  // Fixture worker: on every route wait-step, lease one queued job per known
  // resource and complete it with a clearly labeled synthetic result. No
  // model is contacted; the completion is synthetic by construction.
  const workerStep = async () => {
    for (const rid of ['res-A', 'res-B', 'res-stale', 'res-down']) {
      let lease = null;
      try {
        lease = await store.leaseNextJob({ resource_id: rid, now: t });
      } catch { lease = null; }
      if (!lease) continue;
      const env = lease.envelope;
      const result = {
        request_id: lease.job_id, node_id: env.task.placement.node_id,
        runtime_id: env.task.placement.runtime_id, model_id: env.task.model_id,
        runtime_instance: env.binding.runtime_instance, model_fingerprint: env.binding.model_fingerprint,
        simulated: false, content: `${SYNTHETIC} for ${lease.job_id}`, elapsed_ms: 1, usage: {}, cache: {},
        finish_reason: 'stop',
      };
      const done = await store.completeJob({ job_id: lease.job_id, lease_id: lease.lease_id,
        resource_id: rid, status: 'succeeded', result });
      assert.equal(done.accepted, true, JSON.stringify(done));
    }
  };
  const route = createFabricOpenAIRoute({
    needAuthz: () => null, actor, db, env: {},
    getStore: async () => store,
    clock: () => t,
    sleep: async (ms) => { t += ms; await workerStep(); },
    generateKey: () => 'd1-op-00000001',
    maxWaitMs: 60000, pollIntervalMs: 10,
  });
  const admissions = () => sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions').get().n;
  return { route, store, sqlite, admissions, clock: () => t };
}

const chatBody = (o = {}) => ({ model: 'auto', messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 16, ...o });

test('real store: auto selects the freshest evidenced node and proves it', async () => {
  const { route } = setup();
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'd1-op-a0000001' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.object, 'chat.completion');
  assert.equal(out.body.model, 'synth-model-a');
  assert.equal(out.body.provenance.node_id, 'res-A');
  assert.equal(out.body.provenance.runtime_id, 'ganglion');
  assert.ok(out.body.choices[0].message.content.startsWith(SYNTHETIC));
  assert.equal(out.body.usage, null);
  noNetwork();
});

test('real store: explicit model routes to the evidencing node and runtime', async () => {
  const { route } = setup();
  const out = await route.handleChat({ body: chatBody({ model: 'synth-model-b' }), idempotencyKey: 'd1-op-b0000001' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.provenance.node_id, 'res-B');
  assert.equal(out.body.provenance.runtime_id, 'llama-server');
  noNetwork();
});

test('real store: unknown model is excluded before any admission', async () => {
  const { route, admissions } = setup();
  const before = admissions();
  const out = await route.handleChat({ body: chatBody({ model: 'ghost-model' }), idempotencyKey: 'd1-op-c0000001' });
  assert.equal(out.http, 404);
  assert.equal(out.body.error.code, 'model_not_found');
  assert.equal(admissions(), before);
  noNetwork();
});

test('real store: stale and unready evidence never win auto selection', async () => {
  const { sqlite, route } = setup();
  // Age out res-A evidence: auto must fall to res-B, never to stale/unready.
  sqlite.prepare('UPDATE node_capabilities SET reported_at = ? WHERE node_id = ?')
    .run(iso(T0 - 700000), 'res-A');
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'd1-op-d0000001' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.provenance.node_id, 'res-B');
  noNetwork();
});

test('real store: wrong owner sees no candidates and dispatches nothing', async () => {
  // Same real db, but bob owns nothing: the owner-scoped loader returns no
  // rows, so selection fails closed with 409 and no admission is minted.
  let t = T0;
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  seed(sqlite, T0);
  const db = createD1Shim(sqlite);
  const store = createD1DispatchStore(db, { now: () => t, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000' } });
  const bobRoute = createFabricOpenAIRoute({
    needAuthz: () => null, actor: { kind: 'session', user: { id: 'u_bob' } }, db, env: {},
    getStore: async () => store, clock: () => t,
    sleep: async (ms) => { t += ms; }, generateKey: () => 'd1-op-00000002',
  });
  const out = await bobRoute.handleChat({ body: chatBody(), idempotencyKey: 'd1-op-e0000001' });
  assert.equal(out.http, 409);
  assert.equal(out.body.error.code, 'no_eligible_worker');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions').get().n, 0);
  noNetwork();
});

test('real store: finish evidence is gated at completion through the real worker path', async () => {
  // A dispatched (not yet completed) job is leased, then completed twice:
  // tool_calls evidence is refused (invalid_result) while stop evidence is
  // accepted — finish-reason transport proven through the real store.
  let t = T0;
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);
  seed(sqlite, T0);
  const db = createD1Shim(sqlite);
  const store = createD1DispatchStore(db, { now: () => t, env: { INFERENCE_OWNER_DAILY_TOKENS: '10000' } });
  const route = createFabricOpenAIRoute({
    needAuthz: () => null, actor: { kind: 'session', user: { id: 'u_alice' } }, db, env: {},
    getStore: async () => store, clock: () => t,
    sleep: async (ms) => { t += ms; }, generateKey: () => 'd1-op-00000009',
    maxWaitMs: 60000, pollIntervalMs: 60000,
  });
  const pending = await route.handleChat({ body: chatBody(), idempotencyKey: 'd1-op-g0000001' });
  assert.equal(pending.http, 409); // worker idle: job queued, budget spent waiting
  // Lease strictly before the request deadline (the route clock already sits
  // on it after the budget wait); completion at the deadline is still timely.
  const lease = await store.leaseNextJob({ resource_id: 'res-A', now: T0 + 1000 });
  assert.ok(lease && lease.job_id);
  const env = lease.envelope;
  const base = { request_id: lease.job_id, node_id: env.task.placement.node_id,
    runtime_id: env.task.placement.runtime_id, model_id: env.task.model_id,
    runtime_instance: env.binding.runtime_instance, model_fingerprint: env.binding.model_fingerprint,
    simulated: false, content: `${SYNTHETIC} gated`, elapsed_ms: 1, usage: {}, cache: {} };
  const bad = await store.completeJob({ job_id: lease.job_id, lease_id: lease.lease_id,
    resource_id: 'res-A', status: 'succeeded', result: { ...base, finish_reason: 'tool_calls' } });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'invalid_result');
  const good = await store.completeJob({ job_id: lease.job_id, lease_id: lease.lease_id,
    resource_id: 'res-A', status: 'succeeded', result: { ...base, finish_reason: 'length' } });
  assert.equal(good.accepted, true);
  const status = await route.handleStatus({ idempotencyKey: 'd1-op-g0000001' });
  assert.equal(status.http, 200, JSON.stringify(status));
  assert.equal(status.body.choices[0].finish_reason, 'length');
  noNetwork();
});

test('real store: ownership transfer after settle withholds on status', async () => {
  const { route, sqlite } = setup();
  const sent = await route.handleChat({ body: chatBody(), idempotencyKey: 'd1-op-f0000001' });
  assert.equal(sent.http, 200);
  // Ownership transfer revokes the owner grant: current release authority
  // must refuse, and no withheld content may escape.
  sqlite.prepare("INSERT INTO \"user\" (id, name, email, emailVerified, image, createdAt, updatedAt, demo) VALUES ('u_bob', 'Bob', 'bob@example.com', 1, NULL, ?, ?, 0)")
    .run(iso(T0 - 3600000), iso(T0 - 3600000));
  sqlite.prepare("UPDATE resources SET owner_id = 'u_bob' WHERE id = 'res-A'").run();
  const out = await route.handleStatus({ idempotencyKey: 'd1-op-f0000001' });
  assert.equal(out.http, 503);
  assert.equal(out.body.error.code, 'release_withheld');
  assert.ok(out.body.object !== 'chat.completion');
  noNetwork();
});
