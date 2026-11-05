// F2/F3 regressions for grant-derived shared candidates on the public
// OpenAI-compatible route.
//
// F2: a share whose single grant cannot admit this request (per-request
//     ceiling, remaining tokens or remaining jobs) must not hide another
//     complete eligible share. Grants are never combined; owner-first stays.
// F3: /v1/models must not advertise a shared model whose every grant is
//     spent or demo-mismatched. Discovery promises no capacity; issuance
//     and the atomic hold remain authoritative.
//
// Pure harness: injected providers and store, no worker.js, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFabricOpenAIRoute, listSharedSnapshots } from '../src/inference/fabric-openai-route.mjs';
import { qualifySnapshot } from '../src/inference/model-readiness.mjs';
import { createD1DispatchStore } from '../src/inference/dispatch-store.mjs';

const NOW = Date.parse('2026-11-04T22:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const RECIPIENT = 'u_alice';
const EXPORTER = 'u_bob';
const M = 'qwen-test-a';
const M2 = 'qwen-test-b';

// Resource rows as the shared provider's SELECT returns them. ageMs sets
// server-stamped evidence freshness (smaller = fresher = selected first).
function resourceRow(id, models, ageMs, owner = EXPORTER) {
  return {
    id, owner_id: owner, usable: 1, online: 1, heartbeat_at: iso(NOW - 1000),
    reported_at: iso(NOW - ageMs), runtimes_json: JSON.stringify([{ name: 'llama-server', models }]),
  };
}

function fakeDb(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { prepare: () => ({ bind: (id) => ({ first: async () => byId.get(id) || null }) }) };
}

function harness({ shares, resources, owner = [], issue } = {}) {
  const calls = { issue: [], listLiveShares: 0 };
  const store = {
    async listLiveShares({ principal_id }) {
      calls.listLiveShares += 1;
      assert.equal(principal_id, RECIPIENT);
      return shares;
    },
    async getOperation() { return null; },
    async enqueueJob() { throw new Error('not reached'); },
    async readJob() { return null; },
    async issueAdmission(args) {
      calls.issue.push(args);
      if (issue) return issue(args);
      const err = new Error('stop after issuance'); err.status = 503; err.code = 'TEST_STOP';
      throw err;
    },
  };
  const db = fakeDb(resources);
  const route = createFabricOpenAIRoute({
    needAuthz: () => null,
    actor: { kind: 'session', user: { id: RECIPIENT } },
    db, env: { INFERENCE_ENABLED: '1', FEDERATION_ENABLED: '1' },
    getStore: async () => store,
    candidateProvider: async () => owner,
    clock: () => NOW, sleep: async () => {}, generateKey: () => 'k_f2f3_generated_0001',
  });
  return { route, calls };
}

const share = (grant_id, resource_id, models, maxTokens, extra = {}) => ({
  grant_id, resource_id, exporter_id: EXPORTER, models, maxTokens, ...extra,
});
const chat = (route, body) => route.handleChat({
  body: { messages: [{ role: 'user', content: 'hi' }], ...body }, idempotencyKey: 'idem-f2f3-0001',
});

test('F2: a fresher share whose only grant is too small does not hide a fitting share', async () => {
  const { route, calls } = harness({
    shares: [share('fg_a', 'r_fresh', [M], 16), share('fg_b', 'r_old', [M], 256)],
    resources: [resourceRow('r_fresh', [M], 1000), resourceRow('r_old', [M], 60000)],
  });
  await chat(route, { model: M, max_tokens: 64 });
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.issue[0].resource_id, 'r_old');
  assert.equal(calls.issue[0].grant, 'fg_b');
  assert.equal(calls.issue[0].model_id, M);
});

test('F2: remaining tokens or jobs on the fresher grant are honoured, without combining grants', async () => {
  const { route, calls } = harness({
    shares: [
      share('fg_a', 'r_fresh', [M], 256, { remainingTokens: 10, remainingJobs: 5 }),
      share('fg_a2', 'r_fresh', [M], 256, { remainingTokens: 200, remainingJobs: 0 }),
      share('fg_b', 'r_old', [M], 256, { remainingTokens: 100, remainingJobs: 1 }),
    ],
    resources: [resourceRow('r_fresh', [M], 1000), resourceRow('r_old', [M], 60000)],
  });
  await chat(route, { model: M, max_tokens: 64 });
  assert.equal(calls.issue.length, 1);
  // fg_a has jobs but too few tokens; fg_a2 has tokens but no jobs. Their sum
  // would fit, but a single grant must carry the whole authority.
  assert.equal(calls.issue[0].resource_id, 'r_old');
  assert.equal(calls.issue[0].grant, 'fg_b');
});

test('F2: same resource picks the first fitting grant by id (unchanged)', async () => {
  const { route, calls } = harness({
    shares: [share('fg_1', 'r_x', [M], 16), share('fg_2', 'r_x', [M], 128), share('fg_3', 'r_x', [M], 512)],
    resources: [resourceRow('r_x', [M], 1000)],
  });
  await chat(route, { model: M, max_tokens: 64 });
  assert.equal(calls.issue[0].grant, 'fg_2');
});

test('F2: auto model chooses a fitting share instead of refusing on the freshest', async () => {
  const { route, calls } = harness({
    shares: [share('fg_a', 'r_fresh', [M], 16), share('fg_b', 'r_old', [M2], 256)],
    resources: [resourceRow('r_fresh', [M], 1000), resourceRow('r_old', [M2], 60000)],
  });
  await chat(route, { max_tokens: 64 });
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.issue[0].resource_id, 'r_old');
  assert.equal(calls.issue[0].model_id, M2);
  assert.equal(calls.issue[0].grant, 'fg_b');
});

test('F2: an exact requested model never switches to another model that fits', async () => {
  const { route, calls } = harness({
    shares: [share('fg_a', 'r_fresh', [M], 16), share('fg_b', 'r_old', [M2], 256)],
    resources: [resourceRow('r_fresh', [M], 1000), resourceRow('r_old', [M2], 60000)],
  });
  const out = await chat(route, { model: M, max_tokens: 64 });
  assert.equal(out.http, 429);
  assert.equal(out.body.error.code, 'grant_quota_exhausted');
  assert.equal(calls.issue.length, 0);
});

test('F2: all shares too small or spent answers the existing 429 with no admission', async () => {
  const { route, calls } = harness({
    shares: [
      share('fg_a', 'r_fresh', [M], 16),
      share('fg_b', 'r_old', [M], 256, { remainingTokens: 256, remainingJobs: 0 }),
      share('fg_c', 'r_old', [M], 256, { remainingTokens: 8, remainingJobs: 3 }),
    ],
    resources: [resourceRow('r_fresh', [M], 1000), resourceRow('r_old', [M], 60000)],
  });
  const out = await chat(route, { model: M, max_tokens: 64 });
  assert.equal(out.http, 429);
  assert.equal(out.body.error.code, 'grant_quota_exhausted');
  assert.equal(calls.issue.length, 0);
  const text = JSON.stringify(out.body);
  for (const secret of ['r_fresh', 'r_old', 'fg_', EXPORTER]) assert.ok(!text.includes(secret), secret);
});

test('F2: an unconsented model still answers 404 with no admission', async () => {
  const { route, calls } = harness({
    shares: [share('fg_a', 'r_x', [M], 256)],
    resources: [resourceRow('r_x', [M, M2], 1000)],
  });
  const out = await chat(route, { model: M2, max_tokens: 64 });
  assert.equal(out.http, 404);
  assert.equal(calls.issue.length, 0);
});

test('F2: issuance stays authoritative when authority changed after discovery', async () => {
  const { route, calls } = harness({
    shares: [share('fg_b', 'r_old', [M], 256, { remainingTokens: 256, remainingJobs: 1 })],
    resources: [resourceRow('r_old', [M], 60000)],
    issue: () => {
      const err = new Error('Grant capacity is exhausted for this request.');
      err.status = 429; err.code = 'GRANT_QUOTA_EXHAUSTED';
      throw err;
    },
  });
  const out = await chat(route, { model: M, max_tokens: 64 });
  assert.equal(out.http, 429);
  assert.equal(out.body.error.code, 'grant_quota_exhausted');
  assert.equal(calls.issue.length, 1, 'no second share is tried after an authoritative refusal');
});

test('F2: owner resources still win and shares are not consulted', async () => {
  const owner = [qualifySnapshot({
    resourceId: 'r_own', ownerId: RECIPIENT, usable: true, online: true, heartbeatAt: iso(NOW - 1000),
    reportedAt: iso(NOW - 1000), runtimesJson: JSON.stringify([{ name: 'llama-server', models: [M] }]),
  }, { nowMs: NOW, tenantId: RECIPIENT })];
  const { route, calls } = harness({
    shares: [share('fg_b', 'r_old', [M], 256)], resources: [resourceRow('r_old', [M], 60000)], owner,
  });
  await chat(route, { model: M, max_tokens: 64 });
  assert.equal(calls.listLiveShares, 0);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.issue[0].resource_id, 'r_own');
  assert.equal(calls.issue[0].grant, undefined);
});

test('F3: /v1/models omits shared models whose every grant is spent', async () => {
  const { route } = harness({
    shares: [
      share('fg_a', 'r_a', [M], 256, { remainingTokens: 0, remainingJobs: 4 }),
      share('fg_b', 'r_b', [M2], 256, { remainingTokens: 256, remainingJobs: 0 }),
      share('fg_c', 'r_c', ['qwen-test-c'], 256, { remainingTokens: 1, remainingJobs: 1 }),
    ],
    resources: [resourceRow('r_a', [M], 1000), resourceRow('r_b', [M2], 1000), resourceRow('r_c', ['qwen-test-c'], 1000)],
  });
  const out = await route.handleModels();
  assert.equal(out.http, 200);
  assert.deepEqual(out.body.data.map((m) => m.id).sort(), ['qwen-test-c']);
  const text = JSON.stringify(out.body);
  for (const secret of ['r_a', 'r_b', 'r_c', 'fg_', EXPORTER]) assert.ok(!text.includes(secret), secret);
});

test('F3: listSharedSnapshots carries remaining headroom per grant', async () => {
  const store = { listLiveShares: async () => [share('fg_a', 'r_a', [M], 256, { remainingTokens: 7, remainingJobs: 2 })] };
  const out = await listSharedSnapshots({ db: fakeDb([resourceRow('r_a', [M], 1000)]), store, principalId: RECIPIENT, nowMs: NOW });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].grants, [{ grantId: 'fg_a', models: [M], maxTokens: 256, remainingTokens: 7, remainingJobs: 2 }]);
});

// Store-level F3: listLiveShares reports headroom and drops demo-mismatched
// shares (issuance refuses them as NO_MATCHING_GRANT). A table-dispatching
// fake D1; every other term still goes through fabricGrantLive.
function grantRow(id, resourceId, { usedTokens = 0, usedJobs = 0, maxTokens = 256, maxRequests = 4, exporter = EXPORTER } = {}) {
  return {
    id, status: 'enforced', quarantine_reason: null, route: 'internal', connection_id: 'c_1', exporter_id: exporter,
    snapshot: JSON.stringify([{ resourceId, incarnation: 'inc_1' }]), recipient_node: 'n_alice', recipient_workspace: 'w_alice',
    consumers: JSON.stringify([RECIPIENT]), actions: JSON.stringify(['infer']), models: JSON.stringify([M]),
    ceilings: JSON.stringify({ maxTokens, maxRequests }), version: 1, created_at: iso(NOW - 60000),
    expiry: iso(NOW + 3600000), used_tokens: usedTokens, used_jobs: usedJobs,
  };
}
function tableDb({ grants, resources, demo }) {
  const handler = (sql, args) => {
    if (/json_each\(g\.snapshot\)/.test(sql)) {
      return { all: grants.map((g) => ({ grant_id: g.id, resource_id: JSON.parse(g.snapshot)[0].resourceId })) };
    }
    if (/FROM fabric_grants WHERE id/.test(sql)) return { first: grants.find((g) => g.id === args[0]) || null };
    if (/FROM connections/.test(sql)) return { first: { id: 'c_1', state: 'active' } };
    if (/FROM resources WHERE id/.test(sql)) return { first: resources.find((r) => r.id === args[0]) || null };
    if (/FROM fabric_nodes/.test(sql)) return { first: { id: 'n_alice', workspace: 'w_alice' } };
    if (/FROM "user"/.test(sql)) return { first: args[0] in demo ? { demo: demo[args[0]] } : null };
    return { first: null, all: [] };
  };
  return {
    batch: async () => [],
    exec: async () => ({}),
    prepare: (sql) => {
      const exec = (args) => {
        const r = handler(sql, args);
        return { first: async () => r.first ?? null, all: async () => ({ results: r.all ?? [] }), run: async () => ({}) };
      };
      return { bind: (...args) => exec(args), ...exec([]) };
    },
  };
}

test('F3: listLiveShares reports remaining headroom and drops demo-mismatched shares', async () => {
  const db = tableDb({
    grants: [
      grantRow('fg_1', 'r_1', { usedTokens: 200, usedJobs: 3, maxTokens: 256, maxRequests: 4 }),
      grantRow('fg_2', 'r_2', { exporter: 'u_demo' }),
    ],
    resources: [{ id: 'r_1', owner_id: EXPORTER, incarnation: 'inc_1' }, { id: 'r_2', owner_id: 'u_demo', incarnation: 'inc_1' }],
    demo: { [RECIPIENT]: 0, [EXPORTER]: 0, u_demo: 1 },
  });
  const store = createD1DispatchStore(db, { now: () => NOW, env: { FEDERATION_ENABLED: '1', INFERENCE_ENABLED: '1' } });
  const out = await store.listLiveShares({ principal_id: RECIPIENT });
  assert.deepEqual(out, [{ grant_id: 'fg_1', resource_id: 'r_1', exporter_id: EXPORTER, models: [M], maxTokens: 256,
    remainingTokens: 56, remainingJobs: 1 }]);
});
