// FABRIC067 route handler tests: real adapter + real coordinator over
// deterministic fixture stores. No network, no inference, no authority.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { baseState, createFakeAuthority, succeededJob, nowBase } from './fixtures/dispatch-authority-fake.mjs';
import { createFabricOpenAIRoute, listOwnerCandidates } from '../src/inference/fabric-openai-route.mjs';

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
  let seq = 0;
  const jobs = {};
  const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  return Object.assign(authority, {
    jobs,
    async issueAdmission({ principal, resource_id, model_id, max_tokens, runtime_id = 'ganglion' } = {}) {
      if (!principal || principal.principal_id !== 'user-alice') fail(403, 'OWNER_MISMATCH', 'Owner admission requires resource ownership.');
      if (resource_id !== 'res-1') fail(404, 'RESOURCE_NOT_FOUND', 'Resource not found.');
      if (model_id !== 'model-x') fail(403, 'NO_MATCHING_GRANT', 'No matching grant.');
      if (!Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > 4096) {
        fail(400, 'INVALID_MAX_TOKENS', 'max_tokens must be 1..4096.');
      }
      if (runtime_id !== 'ganglion' && runtime_id !== 'llama-server') fail(400, 'BAD_RUNTIME', 'Unknown runtime.');
      seq += 1;
      const admission_ref = `adm-route-${seq}`;
      state.admissions[admission_ref] = {
        admission_ref, principal_id: principal.principal_id, tenant_id: principal.tenant_id,
        grant_id: 'grant-1', grant_revision: 3, resource_id: 'res-1', incarnation: 'inc-1',
        peer_node: 'node-cpu-1', peer_workspace: 'ws-a', route: 'route-1',
        node_id: 'node-cpu-1', runtime_id, runtime_instance: `${runtime_id}#7`,
        model_id, model_fingerprint: `sha256:${model_id}-q4`,
        max_tokens, expires_at: nowBase + 600000,
        pools: [{ pool_id: 'pool-tokens', amount: max_tokens }, { pool_id: 'pool-slots', amount: 1 }],
      };
      return { admission_ref, expires_at: nowBase + 600000, model_id, max_tokens };
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

const candidateRows = (model = null) => [
  { resourceId: 'res-1', ownerId: 'user-alice', via: { owned: true }, liveness: 'online',
    lastSeenAgeMs: 1000, usable: true, modelIds: ['model-x'], exactTokenMatch: model === 'model-x' },
  { resourceId: 'res-stale', ownerId: 'user-alice', via: { owned: true }, liveness: 'stale',
    lastSeenAgeMs: 600000, usable: true, modelIds: ['model-x'], exactTokenMatch: model === 'model-x' },
  { resourceId: 'res-down', ownerId: 'user-alice', via: { owned: true }, liveness: 'online',
    lastSeenAgeMs: 1000, usable: false, modelIds: ['model-x'], exactTokenMatch: false },
];

function setup({ actor = aliceSession, jobFor = null, dispatchFault = null, candidates = null,
  maxWaitMs = 60000, pollIntervalMs = 10, now = nowBase } = {}) {
  let t = now;
  const state = baseState();
  const store = createFixtureStore(state, { jobFor, dispatchFault });
  const route = createFabricOpenAIRoute({
    needAuthz: needAuthzFor(actor), actor, db: {}, env: {},
    getStore: async () => store,
    candidateProvider: async () => (candidates === null ? candidateRows() : candidates),
    clock: () => t,
    sleep: async (ms) => { t += ms; },
    generateKey: () => 'test-op-00000001',
    maxWaitMs, pollIntervalMs,
  });
  return { route, store, state, advance: (ms) => { t += ms; } };
}

const chatBody = (o = {}) => ({ model: 'auto', messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 16, ...o });

test('models lists only fresh authorized models', async () => {
  const { route } = setup();
  const out = await route.handleModels();
  assert.equal(out.http, 200);
  assert.deepEqual(out.body.data.map((m) => m.id), ['model-x']);
  noNetwork();
});

test('chat auto selects, admits, dispatches and returns a proven completion', async () => {
  const { route, store } = setup();
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000001' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.equal(out.body.object, 'chat.completion');
  assert.equal(out.body.model, 'model-x');
  assert.equal(out.body.choices[0].message.content, 'hello');
  assert.equal(out.body.choices[0].finish_reason, 'unknown');
  assert.equal(out.body.usage, null); // fixture reports only output_tokens: unknown is not zero
  assert.deepEqual(out.body.provenance, { path: 'fabric', job_id: 'job-r-0001', node_id: 'node-cpu-1',
    runtime_id: 'ganglion', model_id: 'model-x', runtime_instance: 'ganglion#7',
    model_fingerprint: 'sha256:model-x-q4', simulated: false });
  assert.equal(Object.keys(store.jobs).length, 1);
  noNetwork();
});

test('explicit matching model and inference key both work; usage passes through when real', async () => {
  const { route } = setup({ actor: aliceKey,
    jobFor: (id, env, rec) => ({ ...succeededJob(id, env),
      result: { ...succeededJob(id, env).result, usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } }) });
  const out = await route.handleChat({ body: chatBody({ model: 'model-x' }), idempotencyKey: 'route-op-00000002' });
  assert.equal(out.http, 200, JSON.stringify(out));
  assert.deepEqual(out.body.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  noNetwork();
});

test('explicit unadmitted model is refused without substitution', async () => {
  const { route, store } = setup();
  const out = await route.handleChat({ body: chatBody({ model: 'other-model' }), idempotencyKey: 'route-op-00000003' });
  assert.equal(out.http, 404);
  assert.equal(out.body.error.code, 'not_found');
  assert.equal(Object.keys(store.jobs).length, 0);
  noNetwork();
});

test('wrong tenant gets no candidates: 409 with no dispatch', async () => {
  const { route, store } = setup({ actor: bobSession, candidates: [] });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000004' });
  assert.equal(out.http, 409);
  assert.equal(out.body.error.code, 'no_eligible_worker');
  assert.equal(Object.keys(store.jobs).length, 0);
  noNetwork();
});

test('stale-only inventory yields no eligible worker', async () => {
  const { route } = setup({ candidates: [candidateRows()[1]] });
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
    db: {}, env: {}, getStore: async () => null, candidateProvider: async () => candidateRows(),
    clock: () => nowBase, sleep: async () => {}, generateKey: () => 'test-op-00000001' });
  // The models list is fresh authorized inventory, not dispatch: it answers
  // from the db even when the dispatch store is absent.
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

test('replay of a settled key reconciles without redispatch', async () => {
  const { route, store } = setup();
  const first = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000009' });
  assert.equal(first.http, 200);
  const second = await route.handleChat({ body: chatBody({ max_tokens: 16 }), idempotencyKey: 'route-op-00000009' });
  assert.equal(second.http, 200, JSON.stringify(second));
  assert.equal(second.body.provenance.job_id, 'job-r-0001');
  assert.equal(Object.keys(store.jobs).length, 1);
  noNetwork();
});

test('wait-budget expiry returns an honest 202 fabric receipt, never a completion', async () => {
  // A running job still carries its identity (real store rows do); only the
  // terminal result is absent, so reconcile stays dispatched until the budget.
  const { route } = setup({ jobFor: (id, env) => ({ id, node_id: env.task.placement.node_id,
    runtime_id: env.task.placement.runtime_id, model_id: env.task.model_id, status: 'running' }),
  maxWaitMs: 100, pollIntervalMs: 50 });
  const out = await route.handleChat({ body: chatBody(), idempotencyKey: 'route-op-00000010' });
  assert.equal(out.http, 202);
  assert.equal(out.body.status, 'dispatched');
  assert.ok(out.body.object !== 'chat.completion');
  noNetwork();
});

test('foreign worker result is rejected, never surfaced', async () => {
  // Settle reads the good row; the route re-read then sees a tampered row
  // (TOCTOU between settlement and surfacing) and refuses it with 502.
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
  // The coordinator itself refuses to settle identity-mismatched jobs: the
  // outcome stays unknown instead of becoming a completion or a failure.
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

test('listOwnerCandidates binds the SQL scope to the verified principal', async () => {
  const seen = [];
  const db = { prepare: (sql) => ({ bind: (...args) => ({ all: async () => {
    seen.push({ sql, args });
    if (args[0] !== 'user-alice') return { results: [] };
    return { results: [{ id: 'res-1', capabilities_json: JSON.stringify(['model-x']),
      online: 1, heartbeat_at: new Date(nowBase - 1000).toISOString(), usable: 1 }] };
  } }) }) };
  const rows = await listOwnerCandidates({ db, principalId: 'user-alice', nowMs: nowBase });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resourceId, 'res-1');
  assert.equal(rows[0].ownerId, 'user-alice');
  assert.deepEqual(rows[0].via, { owned: true });
  assert.equal(rows[0].liveness, 'online');
  assert.deepEqual(rows[0].modelIds, ['model-x']);
  assert.ok(seen[0].sql.includes('WHERE owner_id = ?'));
  const foreign = await listOwnerCandidates({ db, principalId: 'user-bob', nowMs: nowBase });
  assert.deepEqual(foreign, []);
  noNetwork();
});
