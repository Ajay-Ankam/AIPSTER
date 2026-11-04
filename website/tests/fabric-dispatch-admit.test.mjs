// Fabric admission + dispatch end to end on real D1 (node:sqlite shim).
// Honest consent via the real fabric routes (register -> invite -> accept ->
// preview -> approve -> commit); two principals (alice exports, bob
// consumes); bob admits/submits via the real inference routes with the
// flag on; no inference, no network. Synthetic rows only; not sharing
// proof. The consented demo grant names the consumer user id through the
// real preview flow (commitFlow consumers argument); enforcement of the
// consumer/recipient binding is unchanged and re-verified at every step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, readJson } from './qa-helpers.mjs';
import * as core from '../src/fabric/store.mjs';
import { createDispatchCoordinator, TRANSPORT_PROTOCOL } from '../src/inference/dispatch-coordinator.mjs';
import { getDispatchStore } from '../src/inference/dispatch-wiring.mjs';

const RES = 'r_gpu1';
const MODEL = 'llama';

async function setup() {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  const pair = await connectPair(t);
  // The coordinator binds the authenticated principal, so the consented demo
  // grant names the consumer user id through the real preview flow.
  const flow = await commitFlow(t, pair.conn.id, ['r_gpu1'], ['u_bob']);
  const grantId = flow.grant.id;
  // Heartbeat the fixture resource online through the owner key path.
  const key = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, t.alice), body: { name: 'hb', scope: 'heartbeat', resourceId: RES },
  }));
  assert.equal(key.status, 201, key.text);
  const beat = await t.call(`/api/resources/${RES}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.json.secret}` },
    body: { usable: true },
  });
  assert.equal(beat.status, 200, await beat.text());
  return { t, pair, grantId, hb: key.json.secret };
}

const admit = async (s, user, body = {}) => readJson(await s.t.call('/api/inference/admissions', {
  method: 'POST', headers: S(s.t, user),
  body: { resource_id: RES, model_id: MODEL, max_tokens: 100, ...body },
}));
const submitAs = async (s, user, admission, key, extra = {}) => readJson(await s.t.call('/api/jobs', {
  method: 'POST', headers: S(s.t, user),
  body: { contract_version: 'v1.0.0', admission_ref: admission.admission_ref, idempotency_key: key,
    model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100, deadline_at: Date.now() + 60000, ...extra },
}));
const K = (s) => ({ Authorization: `Bearer ${s.hb}` });
const spent = async (s) => {
  const r = await s.t.DB.prepare('SELECT used_tokens AS n, used_jobs AS j FROM fabric_grants WHERE id = ?')
    .bind(s.grantId).first();
  return { n: r.n, j: r.j }; // plain object: node:sqlite rows are null-prototype
};

test('fabric share admits at the route with recipient-side peer pinning', async () => {
  const s = await setup();
  const res = await admit(s, s.t.bob, {});
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.peer_node, undefined, 'peer details stay server-side');
  const row = await s.t.DB.prepare('SELECT peer_node, peer_workspace, pools_json, grant_revision, grant_id FROM dispatch_admissions WHERE admission_ref = ?')
    .bind(res.json.admission_ref).first();
  assert.equal(row.peer_node, s.pair.nodeB.id, 'admission is pinned to the recipient node, not the resource node');
  assert.equal(row.peer_workspace, 'default');
  assert.equal(row.grant_id, s.grantId);
  assert.equal(row.grant_revision, 1);
  assert.deepEqual(JSON.parse(row.pools_json), [{ pool_id: `grant:${s.grantId}`, amount: 100 }]);
});

test('fabric share dispatches to settled with exactly-once charge', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob, {});
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitAs(s, s.t.bob, adm.json, 'bob-fabric-00000001');
  assert.equal(sub.status, 202, sub.text);
  assert.equal(sub.json.status, 'dispatched');
  const lease = await readJson(await s.t.call('/api/worker/jobs/next', { headers: K(s) }));
  assert.equal(lease.status, 200);
  const done = await readJson(await s.t.call(`/api/worker/jobs/${lease.json.job_id}/result`, { method: 'POST', headers: K(s), body: {
    lease_id: lease.json.lease_id, status: 'succeeded',
    result: { request_id: lease.json.job_id, node_id: lease.json.envelope.task.placement.node_id,
      runtime_id: lease.json.envelope.task.placement.runtime_id, model_id: MODEL,
      runtime_instance: lease.json.envelope.binding.runtime_instance,
      model_fingerprint: lease.json.envelope.binding.model_fingerprint,
      simulated: false, content: 'hello', elapsed_ms: 9, usage: { output_tokens: 1 }, cache: {} } } }));
  assert.equal(done.status, 200, done.text);
  const settled = await readJson(await s.t.call('/api/jobs/bob-fabric-00000001', { headers: S(s.t, s.t.bob) }));
  assert.equal(settled.json.status, 'settled');
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'exactly-once charge on the fabric grant, no refund on settle');
});

test('revoked grant refuses admission and dispatch with no result', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob, {});
  assert.equal(adm.status, 201, adm.text);
  const rev = await core.revokeGrant(s.t.DB, { kind: 'session', user: { id: 'u_alice' } }, s.grantId, { expectedVersion: 1 });
  assert.equal(rev.status, 200);
  const again = await admit(s, s.t.bob, {});
  // A revoked grant reads as no live grant at the route: the same 404
  // nondisclosure as a stranger, never a 403 oracle (worker.js admission
  // route) and never a new admission row.
  assert.equal(again.status, 404, again.text);
  assert.equal(again.json.code, 'NOT_FOUND');
  const sub = await submitAs(s, s.t.bob, adm.json, 'bob-fabric-revoked-1');
  assert.equal(sub.json.status, 'rejected', sub.text);
  const jobs = await s.t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').bind().first();
  assert.equal(jobs.n, 0, 'no dispatch row for a revoked grant');
});

test('suspended connection, deny, quarantine and stale incarnation refuse dispatch', async (t) => {
  for (const mutate of [
    async (s) => {
      const row = await s.t.DB.prepare('SELECT version FROM connections WHERE id = ?').bind(s.pair.conn.id).first();
      await core.suspendConnection(s.t.DB, { kind: 'session', user: { id: 'u_alice' } }, s.pair.conn.id, { expectedVersion: row.version });
    },
    async (s) => {
      await s.t.DB.prepare(`INSERT INTO fabric_denies (id, owner_id, principal, resource_id, action, created_at)
        VALUES ('dn_x', 'u_alice', 'u_bob', ?, 'infer', ?)`).bind(RES, new Date().toISOString()).run();
    },
    async (s) => {
      await s.t.DB.prepare('UPDATE fabric_grants SET quarantine_reason = ? WHERE id = ?').bind('issuer-ambiguous', s.grantId).run();
    },
    async (s) => {
      await s.t.DB.prepare("UPDATE resources SET incarnation = 'gen2' WHERE id = ?").bind(RES).run();
    },
  ]) {
    const s = await setup();
    const adm = await admit(s, s.t.bob, {});
    assert.equal(adm.status, 201, adm.text);
    await mutate(s);
    const sub = await submitAs(s, s.t.bob, adm.json, `bob-fabric-refuse-${Math.random().toString(36).slice(2, 8)}`);
    assert.equal(sub.json.status, 'rejected', sub.text);
    assert.equal(sub.json.code, 'NO_MATCHING_GRANT', sub.text);
    const count = await s.t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').bind().first();
    assert.equal(count.n, 0, 'withheld: no dispatch row');
    await s.t.sqlite.close();
  }
});

test('malformed or missing spend counters refuse admission with no rows or spend', async () => {
  // 630 review gap on fe2ce0b: a pre-0029 schema (or a corrupt counter)
  // reads as undefined/NaN through Number() coercion, and NaN headroom
  // arithmetic silently passes — admission minted at 201 with zero
  // spend recorded. Counters must be strict nonnegative safe integers
  // before any headroom is accepted; valid 0 stays admissible.
  const cases = [
    ['missing columns (pre-0029 schema)', async (s) => {
      await s.t.DB.prepare('ALTER TABLE fabric_grants DROP COLUMN used_tokens').bind().run();
      await s.t.DB.prepare('ALTER TABLE fabric_grants DROP COLUMN used_jobs').bind().run();
    }, true],
    ['null counters (nullable re-add, no coercion to zero)', async (s) => {
      await s.t.DB.prepare('ALTER TABLE fabric_grants DROP COLUMN used_tokens').bind().run();
      await s.t.DB.prepare('ALTER TABLE fabric_grants ADD COLUMN used_tokens INTEGER').bind().run();
    }, false],
    ['fractional counters', async (s) => {
      await s.t.DB.prepare('UPDATE fabric_grants SET used_tokens = 1.5, used_jobs = 0 WHERE id = ?').bind(s.grantId).run();
    }, false],
    ['negative counters', async (s) => {
      await s.t.DB.prepare('UPDATE fabric_grants SET used_tokens = 0, used_jobs = -5 WHERE id = ?').bind(s.grantId).run();
    }, false],
    ['non-numeric text counters (no coercion)', async (s) => {
      // Numeric text ('100') is normalized to 100 by SQLite INTEGER
      // affinity on write, so only genuinely non-numeric text reaches the
      // guard — and must be refused, never coerced.
      await s.t.DB.prepare("UPDATE fabric_grants SET used_tokens = 'abc', used_jobs = 'x' WHERE id = ?").bind(s.grantId).run();
    }, false],
  ];
  for (const [name, mutate, dropped] of cases) {
    const s = await setup();
    await mutate(s);
    const adm = await admit(s, s.t.bob, {});
    assert.equal(adm.status, 404, `${name}: schema failure is never a successful admission: ${adm.text}`);
    assert.equal(adm.json.code, 'NOT_FOUND', name);
    const a = await s.t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions').bind().first();
    assert.equal(a.n, 0, `${name}: no admission minted`);
    const j = await s.t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').bind().first();
    assert.equal(j.n, 0, `${name}: no dispatch row`);
    if (!dropped) {
      const r = await s.t.DB.prepare('SELECT used_tokens AS n, used_jobs AS j FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
      assert.ok(!(r.n === 0 && r.j === 0), `${name}: counters not reset to zero`);
    }
  }
});

test('wrong tenant cannot use another principal admission', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob, {});
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitAs(s, s.t.alice, adm.json, 'alice-fabric-wrong-tenant-1');
  assert.notEqual(sub.json.status, 'dispatched', sub.text);
});

test('concurrent oversubscription holds exactly one operation', async () => {
  const s = await setup();
  await s.t.DB.prepare('UPDATE fabric_grants SET ceilings = ? WHERE id = ?')
    .bind(JSON.stringify({ maxTokens: 100, maxRequests: 10 }), s.grantId).run();
  const a1 = await admit(s, s.t.bob, {});
  const a2 = await admit(s, s.t.bob, {});
  assert.equal(a1.status, 201, a1.text);
  assert.equal(a2.status, 201, a2.text);
  const [r1, r2] = await Promise.all([
    submitAs(s, s.t.bob, a1.json, 'bob-fabric-race-1'),
    submitAs(s, s.t.bob, a2.json, 'bob-fabric-race-2'),
  ]);
  const codes = [r1.json.status, r2.json.status].sort();
  assert.deepEqual(codes, ['dispatched', 'rejected']);
  const loser = r1.json.status === 'rejected' ? r1 : r2;
  assert.equal(loser.json.code, 'BUDGET_EXHAUSTED');
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'exactly one charge, no partial spend');
});

test('cancel releases the fabric hold for reuse', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob, {});
  assert.equal(adm.status, 201, adm.text);
  // Deterministic pre-start cancel: gate the admission linearization point
  // with a signal-only wrapper (no decision changed). The coordinator takes
  // the real fabric hold first, then stalls before the admit CAS, so the
  // real cancel route below lands in the claimed/holding window where the
  // coordinator fences the start and releases exactly this op's holds.
  // (Past-start cancel is an unsupported capability by contract and retains
  // spend; the deadline path cannot be hit deterministically via HTTP.)
  const store = await getDispatchStore(s.t.env, s.t.DB);
  assert.ok(store, 'real dispatch store');
  let enteredAdmit = false;
  let gateResolve;
  const gate = new Promise((r) => { gateResolve = r; });
  const gated = { ...store, admit: async (args) => { enteredAdmit = true; await gate; return store.admit(args); } };
  let transportCalled = false;
  const coord = createDispatchCoordinator({
    resolvePrincipal: async () => ({ principal_id: 'u_bob', tenant_id: 'u_bob', actor_kind: 'session' }),
    authority: gated,
    transport: { capabilities: { protocol: TRANSPORT_PROTOCOL, instance_pin: true, deadline: true },
      dispatch: async () => { transportCalled = true; throw new Error('a cancelled op must never dispatch'); } },
  });
  const stalled = coord.submit({ kind: 'session', user: { id: 'u_bob' } }, {
    contract_version: 'v1.0.0', admission_ref: adm.json.admission_ref, idempotency_key: 'bob-fabric-cancel-1',
    model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100, deadline_at: Date.now() + 60000,
  });
  stalled.then(() => {}, () => {}); // observed here; the real outcome is asserted via await below
  const t0 = Date.now();
  while (!enteredAdmit) {
    if (Date.now() - t0 > 5000) assert.fail('submit never reached the admission gate');
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'hold charged before the admission CAS');
  const cancel = await readJson(await s.t.call('/api/jobs/bob-fabric-cancel-1/cancel', {
    method: 'POST', headers: S(s.t, s.t.bob),
  }));
  assert.equal(cancel.json.status, 'cancelled_before_start', cancel.text);
  assert.equal(cancel.json.code, 'CANCELLED', cancel.text);
  assert.deepEqual(await spent(s), { n: 0, j: 0 }, 'release returns the held charge');
  gateResolve();
  const done = await stalled;
  assert.equal(done.status, 'rejected', JSON.stringify(done));
  assert.equal(done.code, 'ADMISSION_REJECTED', JSON.stringify(done));
  assert.equal(transportCalled, false, 'no dispatch after pre-start cancel');
  // Reuse: a fresh operation on the same grant dispatches with the full hold.
  const adm2 = await admit(s, s.t.bob, {});
  assert.equal(adm2.status, 201, adm2.text);
  const sub2 = await submitAs(s, s.t.bob, adm2.json, 'bob-fabric-cancel-2');
  assert.equal(sub2.json.status, 'dispatched', sub2.text);
  assert.deepEqual(await spent(s), { n: 100, j: 1 });
});

test('revision carries spend and lowered ceilings block new starts', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob, {});
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitAs(s, s.t.bob, adm.json, 'bob-fabric-rev-1');
  assert.equal(sub.json.status, 'dispatched', sub.text);
  // Simulate a committed revision: version bump, tighter ceilings. Spend is
  // stored on the stable grant id, so it carries over; nothing is refunded.
  await s.t.DB.prepare('UPDATE fabric_grants SET version = 2, ceilings = ? WHERE id = ?')
    .bind(JSON.stringify({ maxTokens: 50, maxRequests: 10 }), s.grantId).run();
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'revision carries spend, no replenish');
  const stale = await submitAs(s, s.t.bob, adm.json, 'bob-fabric-rev-stale-1');
  assert.equal(stale.json.status, 'rejected', stale.text);
  // Spent+held (100/1) already exceeds the revised ceiling (50/10), so even
  // a 40-token request is refused at issuance: cumulative, no replenish.
  const adm2 = await admit(s, s.t.bob, { max_tokens: 40 });
  assert.equal(adm2.status, 429, adm2.text);
  assert.equal(adm2.json.code, 'GRANT_QUOTA_EXHAUSTED');
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'refused admissions move no spend');
  // A per-request ceiling breach stays refused at the lookup layer.
  const tooBig = await admit(s, s.t.bob, { max_tokens: 200 });
  assert.equal(tooBig.status, 429, tooBig.text, 'issuance refuses above the revised ceiling');
  assert.equal(tooBig.json.code, 'GRANT_QUOTA_EXHAUSTED');
});
