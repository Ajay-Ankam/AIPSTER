// FABRIC067 route handler tests: real adapter + real coordinator over
// deterministic fixture stores. No network, no inference, no authority.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { baseState, createFakeAuthority, succeededJob, nowBase } from './fixtures/dispatch-authority-fake.mjs';
import { createFabricOpenAIRoute, listReadinessSnapshots } from '../src/inference/fabric-openai-route.mjs';

// ---- zero network guard (mirrors dispatch-coordinator.test.mjs) ----
const network = { fetch: 0, ws: 0, socket: 0 };
const realFetch = globalThis.fetch;
const realWs = globalThis.WebSocket;
const realConnect = net.Socket.prototype.connect;
globalThis.fetch = async () => { network.fetch += 1; throw new Error('network forbidden in route tests'); };
globalThis.WebSocket = class { constructor() { network.ws += 1; throw new Error('WebSocket forbidden'); } };
net.Socket.prototype.connect = function () { network.socket += 1; throw new Error('socket forbidden'); };
after(() => {
  globalThis.fetch = realFetch; globalThis.WebSocket = realWs; net.Socket.prototype.connect = realConnect;
});
const noNetwork = () => assert.deepEqual(network, { fetch: 0, ws: 0, socket: 0 });

// ---- deterministic fixture store: fake authority + job transport + issuance
function createFixtureStore(state, { jobFor = null, dispatchFault = null } = {}) {
  const authority = createFakeAuthority(state);
  // Second node grant mirroring grant-1 terms (the fake authority ships one).
  state.grants['grant-2'] = { ...state.grants['grant-1'], id: 'grant-2',
    recipientNode: 'node-cpu-2', resourceId: 'res-b', models: ['model-b'] };
  let seq = 0;
  const jobs = {};
  const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return Object.assign(authority, {
    jobs,
    admissionsIssued: 0,
    async issueAdmission({ principal, resource_id, model_id, max_tokens, runtime_id = 'ganglion' } = {}) {
      if (!principal || principal.principal_id !== 'user-alice') fail(403, 'OWNER_MISMATCH', 'Owner admission requires resource ownership.');
      if (resource_id !== 'res-1' && resource_id !== 'res-b') fail(404, 'RESOURCE_NOT_FOUND', 'Resource not found.');
      if (model_id !== 'model-x' && model_id !== 'model-b') fail(403, 'NO_MATCHING_GRANT', 'No matching grant.');
      if (!Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > 4096) {
        fail(400, 'INVALID_MAX_TOKENS', 'max_tokens must be 1..4096.');
      }
      if (runtime_id !== 'ganglion' && runtime_id !== 'llama-server') fail(400, 'BAD_RUNTIME', 'Unknown runtime.');
      seq += 1;
      const admission_ref = `adm-route-${seq}`;
      const nodeId = resource_id === 'res-b' ? 'node-cpu-2' : 'node-cpu-1';
      state.admissions[admission_ref] = {
        admission_ref, principal_id: principal.principal_id, tenant_id: principal.tenant_id,
        grant_id: resource_id === 'res-b' ? 'grant-2' : 'grant-1', grant_revision: 3,
        resource_id, incarnation: 'inc-1',
        peer_node: nodeId, peer_workspace: 'ws-a', route: 'route-1',
        // node_id is the resource id (mirrors the real store issuance).
        node_id: resource_id, runtime_id,
        runtime_instance: `${runtime_id}#7`,
        model_id, model_fingerprint: `sha256:${model_id}-q4`,
        max_tokens, expires_at: nowBase + 600000,
        pools: [{ pool_id: 'pool-tokens', amount: max_tokens }, { pool_id: 'pool-slots', amount: 1 }],
      };
      this.admissionsIssued += 1;
      return { admission_ref, expires_at: nowBase + 600000, model_id, max_tokens };
    },
    async resolveAdmission({ principal, admission_ref } = {}) {
      const a = state.admissions[admission_ref];
      if (!a || a.principal_id !== principal.principal_id || a.tenant_id !== principal.tenant_id) return null;
      return clone(a);
    },
    async enqueueJob(envelope) {
      if (dispatchFault === 'throw') throw new Error('fixture transport: connection lost after send');
      const job_id = `job-r-${String(Object.keys(jobs).length + 1).padStart(4, '0')}`;
      jobs[job_id] = { envelope, status: 'running' };
      return { accepted: true, job_id };
    },
    async readJob({ job_id } = {}) {
      const rec = jobs[job_id];
      if (!rec) throw new Error('fixture store: unknown job');
      if (jobFor) return jobFor(job_id, rec.envelope, rec);
      return succeededJob(job_id, rec.envelope);
    },
  });
}

const aliceSession = { kind: 'session', user: { id: 'user-alice' } };
const aliceKey = { kind: 'key', user: { id: 'user-alice' }, key: { scope: 'inference' } };
const heartbeatKey = { kind: 'key', user: { id: 'user-alice' }, key: { scope: 'heartbeat', resource_id: 'res-1' } };
const bobSession = { kind: 'session', user: { id: 'user-bob' } };

// needAuthz mirror of worker.js semantics for the verified actors above.
const needAuthzFor = (actor) => (scope = 'read') => {
  if (actor.kind === 'session') return null;
  if (actor.kind === 'key') {
    if (actor.key.scope === 'heartbeat') return { status: 403, json: { code: 'KEY_SCOPE' } };
    if (actor.key.scope === 'inference' || scope === 'read') return null;
    return { status: 403, json: { code: 'KEY_SCOPE' } };
  }
  return { status: 401, json: { code: 'AUTH_REQUIRED' } };
};

const iso = (ms) => new Date(ms).toISOString();
// Loader-shaped DB rows (resources + node_capabilities) so every test runs
// the REAL default candidate loader, not a hand-shaped provider.
const dbRows = () => [
  { id: 'res-1', owner_id: 'user-alice', usable: 1, online: 1,
    heartbeat_at: iso(nowBase - 1000), reported_at: iso(nowBase - 2000),
    runtimes_json: JSON.stringify([{ name: 'ganglion', models: ['model-x'] }]) },
  { id: 'res-b', owner_id: 'user-alice', usable: 1, online: 1,
    heartbeat_at: iso(nowBase - 1000), reported_at: iso(nowBase - 3000),
    runtimes_json: JSON.stringify([{ name: 'llama-server', models: ['model-b'] }]) },
  { id: 'res-stale', owner_id: 'user-alice', usable: 1, online: 1,
    heartbeat_at: iso(nowBase - 600000), reported_at: iso(nowBase - 700000),
    runtimes_json: JSON.stringify([{ name: 'ganglion', models: ['model-x'] }]) },
];

const stubDb = (rows) => ({ prepare: () => ({ bind: (owner) => ({ all: async () => (
  { results: rows.filter((r) => r.owner_id === owner) }) }) }) });

function setup({ actor = aliceSession, jobFor = null, dispatchFault = null, rows = null,
  maxWaitMs = 60000, pollIntervalMs = 10, now = nowBase } = {}) {
  let t = now;
  const state = baseState();
  const store = createFixtureStore(state, { jobFor, dispatchFault });
  const route = createFabricOpenAIRoute({
    needAuthz: needAuthzFor(actor), actor, db: stubDb(rows === null ? dbRows() : rows), env: {},
    getStore: async () => store,
    clock: () => t,
    sleep: async (ms) => { t += ms; },
    generateKey: () => 'test-op-00000001',
    maxWaitMs, pollIntervalMs,
  });
  return { route, store, state, advance: (ms) => { t += ms; } };
}

const chatBody = (o = {}) => ({ model: 'auto', messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 16, ...o });

test('models lists only evidenced servable models', async () => {
  const { route } = setup();
  const out = await route.handleModels();
  assert.equal(out.http, 200);
  assert.deepEqual(out.body.data.map((m) => m.id), ['model-b', 'model-x']);
  noNetwork();
});

test('chat auto selects the freshest evidence and returns a proven completion', async () => {
  const { route, store } = setup();
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000001' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.object, 'chat.completion');
  assert.equal(out.body.model, 'model-x');
  assert.equal(out.body.provenance.node_id, 'res-1');
  assert.equal(out.body.provenance.runtime_id, 'ganglion');
  assert.equal(Object.keys(store.jobs).length, 1);
  noNetwork();
});

test('explicit matching model and inference key both work; usage passes through when real', async () => {
  const { route } = setup({ actor: aliceKey,
    jobFor: (id, env, rec) => ({ ...succeededJob(id, env),
      result: { ...succeededJob(id, env).result, usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } }) });
  const out = await route.handleChat({ body: chatBody({ model: 'model-b' }), idempotencyKey: 'route-op-00000002' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.provenance.node_id, 'res-b');
  assert.deepEqual(out.body.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  noNetwork();
});

test('unadvertised model never reaches issuance: 404 with zero admissions', async () => {
  const { route, store } = setup();
  let called = null;
  const issue = store.issueAdmission.bind(store);
  store.issueAdmission = async (args) => { called = { model_id: args.model_id, runtime_id: args.runtime_id }; return issue(args); };
  const out = await route.handleChat({ body: chatBody({ model: 'not-advertised' }), idempotencyKey: 'route-op-00000003' });
  assert.equal(out.http, 404);
  assert.equal(out.body.error.code, 'model_not_found');
  assert.equal(called, null);
  assert.equal(store.admissionsIssued, 0);
  assert.equal(Object.keys(store.jobs).length, 0);
  noNetwork();
});

test('revoked release withholds content on every surfacing path', async () => {
  const { route: r2, store: s2 } = setup();
  s2.recheckRelease = async () => ({ ok: false, reason: 'synthetic_release_refused' });
  const chat = await r2.handleChat({ body: chatBody(), idempotencyKey: 'probe-release-0001' });
  assert.equal(chat.http, 503);
  assert.equal(chat.body.error.code, 'release_withheld');
  assert.ok(chat.body.object !== 'chat.completion');
  const status = await r2.handleStatus({ idempotencyKey: 'probe-release-0001' });
  assert.equal(status.http, 503);
  assert.equal(status.body.error.code, 'release_withheld');
  noNetwork();
});

test('changed-payload replay keeps IDEMPOTENCY_CONFLICT and allocates nothing new', async () => {
  const { route, store } = setup();
  const first = await route.handleChat({ body: chatBody(), idempotencyKey: 'probe-replay-0001' });
  assert.equal(first.http, 200);
  const issued = store.admissionsIssued;
  const second = await route.handleChat(
    { body: chatBody({ messages: [{ role: 'user', content: 'Different request with same key' }] }),
      idempotencyKey: 'probe-replay-0001' });
  assert.equal(second.http, 409);
  assert.equal(second.body.error.code, 'idempotency_conflict');
  assert.equal(second.body.object === 'chat.completion', false);
  assert.equal(store.admissionsIssued, issued);
  noNetwork();
});

test('same-payload retry reconciles without new admissions', async () => {
  const { route, store } = setup();
  const first = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000009' });
  assert.equal(first.http, 200);
  const issued = store.admissionsIssued;
  const second = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000009' });
  assert.equal(second.http, 200, JSON.stringify(second));
  assert.equal(second.body.provenance.job_id, 'job-r-0001');
  assert.equal(store.admissionsIssued, issued);
  assert.equal(Object.keys(store.jobs).length, 1);
  noNetwork();
});

test('supplied malformed keys are 400, never silently replaced', async () => {
  const { route, store } = setup();
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'bad key!' });
  assert.equal(out.http, 400);
  assert.equal(store.admissionsIssued, 0);
  noNetwork();
});

test('absent keys are server-generated for keyless clients', async () => {
  const { route } = setup();
  const out = await route.handleChat({ body: chatBody() });
  assert.equal(out.http, 200, JSON.stringify(out));
  noNetwork();
});

test('wrong tenant gets no snapshots: 409 with no dispatch', async () => {
  const { route, store } = setup({ actor: bobSession, rows: [] });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000004' });
  assert.equal(out.http, 409);
  assert.equal(out.body.error.code, 'no_eligible_worker');
  assert.equal(Object.keys(store.jobs).length, 0);
  noNetwork();
});

test('stale-only evidence yields no eligible worker', async () => {
  const { route } = setup({ rows: [dbRows()[2]] });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000005' });
  assert.equal(out.http, 409);
  assert.equal(out.body.error.code, 'no_eligible_worker');
  noNetwork();
});

test('heartbeat keys authorize nothing: denied response passes through', async () => {
  const { route, store } = setup({ actor: heartbeatKey });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000006' });
  assert.deepEqual(out, { passthrough: { status: 403, json: { code: 'KEY_SCOPE' } } });
  assert.equal(Object.keys(store.jobs).length, 0);
  noNetwork();
});

test('missing store blocks chat (503) but inventory listing needs only the db', async () => {
  const route = createFabricOpenAIRoute({ needAuthz: needAuthzFor(aliceSession), actor: aliceSession,
    db: stubDb(dbRows()), env: {}, getStore: async () => null,
    clock: () => nowBase, sleep: async () => {}, generateKey: () => 'test-op-00000001' });
  assert.equal((await route.handleModels()).http, 200);
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000007' });
  assert.equal(out.http, 503);
  assert.equal(out.body.error.code, 'dispatch_unavailable');
  noNetwork();
});

test('transport loss is uncertain: 503, no retry, holds retained', async () => {
  const { route } = setup({ dispatchFault: 'throw' });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000008' });
  assert.equal(out.http, 503);
  assert.equal(out.body.automatic_retry, false);
  assert.equal(out.body.remote_stopped, false);
  noNetwork();
});

test('wait-budget expiry is a typed 409 pending error, never a completion', async () => {
  const { route } = setup({ jobFor: (id, env) => ({ id, node_id: env.task.placement.node_id,
    runtime_id: env.task.placement.runtime_id, model_id: env.task.model_id, status: 'running' }),
  maxWaitMs: 100, pollIntervalMs: 50 });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000010' });
  assert.equal(out.http, 409);
  assert.equal(out.body.error.code, 'operation_in_progress');
  assert.ok(out.body.object !== 'chat.completion');
  assert.equal(out.body.automatic_retry, false);
  assert.ok(typeof out.body.status_route === 'string' && out.body.status_route.includes('route-op-00000010'));
  noNetwork();
});

test('foreign worker result is rejected, never surfaced', async () => {
  let reads = 0;
  const { route } = setup({ jobFor: (id, env) => {
    reads += 1;
    const j = succeededJob(id, env);
    if (reads > 1) j.node_id = 'wrong-node';
    return j;
  } });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000011' });
  assert.equal(out.http, 502);
  assert.equal(out.body.error.code, 'result_rejected');
  noNetwork();
});

test('foreign result at poll time never settles: uncertain, holds retained', async () => {
  const { route } = setup({ jobFor: (id, env) => { const j = succeededJob(id, env); j.node_id = 'wrong-node'; return j; } });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000013' });
  assert.equal(out.http, 503);
  assert.equal(out.body.automatic_retry, false);
  noNetwork();
});

test('status path reconciles a settled key to the same proven completion', async () => {
  const { route } = setup();
  const sent = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000012' });
  assert.equal(sent.http, 200);
  const out = await route.handleStatus({ idempotencyKey: 'route-op-00000012' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.provenance.job_id, 'job-r-0001');
  const missing = await route.handleStatus({ idempotencyKey: 'route-op-00000999' });
  assert.equal(missing.http, 404);
  noNetwork();
});

test('listReadinessSnapshots binds the SQL scope to the verified principal', async () => {
  const seen = [];
  const db = { prepare: (sql) => ({ bind: (...args) => ({ all: async () => {
    seen.push({ sql, args });
    if (args[0] !== 'user-alice') return { results: [] };
    return { results: [{ id: 'res-1', owner_id: 'user-alice', usable: 1, online: 1,
      heartbeat_at: iso(nowBase - 1000), reported_at: iso(nowBase - 2000),
      runtimes_json: JSON.stringify([{ name: 'ganglion', models: ['model-x'] }]) }] };
  } }) }) };
  const { listReadinessSnapshots: list } = await import('../src/inference/fabric-openai-route.mjs');
  const rows = await list({ db, principalId: 'user-alice', nowMs: nowBase });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resourceId, 'res-1');
  assert.equal(rows[0].excluded, null);
  assert.ok(seen[0].sql.includes('WHERE r.owner_id = ?'));
  const foreign = await list({ db, principalId: 'user-bob', nowMs: nowBase });
  assert.deepEqual(foreign, []);
  noNetwork();
});
