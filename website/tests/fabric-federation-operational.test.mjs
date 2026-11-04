// Federation operational slice (CLAUDE135): cross-owner execution inside the
// shared AIPSTER control plane, initiated by the RECIPIENT's own user-issued
// inference API key, plus the lease-time authority boundary. Synthetic
// principals on the real local D1 store and real routes; the exporter worker
// is played with canonical wire shapes (no engine, no network). Unit/local
// integration proof level only — not real identities, not production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';

const RES = 'r_gpu1';
const MODEL = 'llama';

async function heartbeatKey(t, user, resourceId) {
  const key = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, user), body: { name: `hb-${resourceId}`, scope: 'heartbeat', resourceId },
  }));
  assert.equal(key.status, 201, key.text);
  const beat = await t.call(`/api/resources/${resourceId}/heartbeat`, {
    method: 'POST', headers: { Authorization: `Bearer ${key.json.secret}` }, body: { usable: true },
  });
  assert.equal(beat.status, 200, await beat.text());
  return key.json.secret;
}

async function userKey(t, user, scope) {
  const key = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, user), body: { name: `${user.id}-${scope}`, scope },
  }));
  assert.equal(key.status, 201, key.text);
  return { id: key.json.id, secret: key.json.secret };
}

async function setup({ grant = true } = {}) {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  const pair = await connectPair(t);
  const flow = grant ? await commitFlow(t, pair.conn.id, [RES], ['u_bob']) : null;
  const hb = await heartbeatKey(t, t.alice, RES);
  const bobKey = await userKey(t, t.bob, 'inference');
  return { t, pair, grantId: flow && flow.grant.id, hb, bobKey };
}

const B = (secret) => ({ Authorization: `Bearer ${secret}` });
const admitWith = async (t, headers, body = {}) => readJson(await t.call('/api/inference/admissions', {
  method: 'POST', headers, body: { resource_id: RES, model_id: MODEL, max_tokens: 100, ...body },
}));
const submitWith = async (t, headers, admission, key) => readJson(await t.call('/api/jobs', {
  method: 'POST', headers,
  body: { contract_version: 'v1.0.0', admission_ref: admission.admission_ref, idempotency_key: key,
    model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100, deadline_at: Date.now() + 60000 },
}));
const lease = async (t, hb) => t.call('/api/worker/jobs/next', { headers: B(hb) });
const succeeded = (l, content = 'hello') => ({
  lease_id: l.lease_id, status: 'succeeded',
  result: { request_id: l.job_id, node_id: l.envelope.task.placement.node_id,
    runtime_id: l.envelope.task.placement.runtime_id, model_id: MODEL,
    runtime_instance: l.envelope.binding.runtime_instance,
    model_fingerprint: l.envelope.binding.model_fingerprint,
    simulated: false, content, elapsed_ms: 9, usage: { output_tokens: 1 }, cache: {} },
});
const count = async (t, sql, ...b) => (await t.DB.prepare(sql).bind(...b).first()).n;
const spent = async (t, id) => {
  const r = await t.DB.prepare('SELECT used_tokens AS n, used_jobs AS j FROM fabric_grants WHERE id = ?').bind(id).first();
  return { n: r.n, j: r.j };
};

test('accepting an invitation alone grants no compute at the dispatch route', async () => {
  const s = await setup({ grant: false });
  assert.equal(s.pair.conn.state ?? 'active', 'active');
  const viaKey = await admitWith(s.t, B(s.bobKey.secret));
  assert.equal(viaKey.status, 404, viaKey.text);
  const viaSession = await admitWith(s.t, S(s.t, s.t.bob));
  assert.equal(viaSession.status, 404, viaSession.text);
  assert.equal(await count(s.t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);
});

test('recipient-issued inference key executes on the exporter share as the recipient', async () => {
  const s = await setup();
  const adm = await admitWith(s.t, B(s.bobKey.secret));
  assert.equal(adm.status, 201, adm.text);
  const row = await s.t.DB.prepare('SELECT principal_id, tenant_id, grant_id FROM dispatch_admissions').first();
  assert.equal(row.principal_id, 'u_bob', 'key initiation binds the key owner, never the exporter');
  assert.equal(row.tenant_id, 'u_bob');
  assert.equal(row.grant_id, s.grantId);

  const sub = await submitWith(s.t, B(s.bobKey.secret), adm.json, 'bob-key-op-000001');
  assert.equal(sub.status, 202, sub.text);
  const l = await readJson(await lease(s.t, s.hb));
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.job_id, sub.json.job_id);
  const posted = await readJson(await s.t.call(`/api/worker/jobs/${l.json.job_id}/result`, {
    method: 'POST', headers: B(s.hb), body: succeeded(l.json),
  }));
  assert.equal(posted.status, 200, posted.text);
  const out = await readJson(await s.t.call('/api/jobs/bob-key-op-000001', { headers: B(s.bobKey.secret) }));
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.status, 'settled');
  assert.equal(out.json.outcome.content, 'hello');
  assert.deepEqual(await spent(s.t, s.grantId), { n: 100, j: 1 }, 'charged once on the fabric grant');
  // The exporter cannot read the recipient's operation by key/idempotency.
  const peek = await readJson(await s.t.call('/api/jobs/bob-key-op-000001', { headers: S(s.t, s.t.alice) }));
  assert.notEqual(peek.json && peek.json.outcome && peek.json.outcome.content, 'hello');
});

test('key initiation cannot broaden scope, name another principal, or survive key revocation', async () => {
  const s = await setup();
  // A key cannot mint consent: previews/approvals/grants stay session-only.
  const prev = await readJson(await s.t.call('/v1/fabric/previews', {
    method: 'POST', headers: { ...B(s.bobKey.secret), 'Idempotency-Key': freshKey() },
    body: { connectionId: s.pair.conn.id, resourceIds: [RES], consumers: ['u_bob'], models: [MODEL], maxTokens: 1000, maxRequests: 10 },
  }));
  assert.equal(prev.status, 403, prev.text);
  // No principal/grant override fields.
  for (const extra of [{ principal_id: 'u_alice' }, { grant_id: s.grantId }, { tenant_id: 'u_alice' }]) {
    const r = await admitWith(s.t, B(s.bobKey.secret), extra);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'UNSUPPORTED_FIELD');
  }
  // A read-scoped key of the recipient cannot initiate execution.
  const readKey = await userKey(s.t, s.t.bob, 'read');
  const r2 = await admitWith(s.t, B(readKey.secret));
  assert.equal(r2.status, 403, r2.text);
  assert.equal(r2.json.code, 'KEY_SCOPE');
  // The exporter's heartbeat key authorizes no admission.
  const r3 = await admitWith(s.t, B(s.hb));
  assert.equal(r3.status, 403, r3.text);
  // Revoking the recipient's key kills key initiation; the grant is untouched.
  const del = await s.t.call(`/api/keys/${s.bobKey.id}`, { method: 'DELETE', headers: S(s.t, s.t.bob) });
  assert.equal(del.status, 200, await del.text());
  const r4 = await admitWith(s.t, B(s.bobKey.secret));
  assert.equal(r4.status, 401, r4.text);
  assert.equal(await count(s.t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);
  const bySession = await admitWith(s.t, S(s.t, s.t.bob));
  assert.equal(bySession.status, 201, 'session consent is independent of the revoked key');
});

test('another tenant worker key cannot lease the exporter share job', async () => {
  const s = await setup();
  const now = new Date().toISOString();
  await s.t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
    VALUES ('r_bob1','u_bob','bob-1','local','declared','x','y','[]',1,0,0,0,NULL,'{}','owner only','{}',NULL,?)`).bind(now).run();
  const bobHb = await heartbeatKey(s.t, s.t.bob, 'r_bob1');
  const adm = await admitWith(s.t, B(s.bobKey.secret));
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitWith(s.t, B(s.bobKey.secret), adm.json, 'bob-key-op-000002');
  assert.equal(sub.status, 202, sub.text);
  const wrong = await lease(s.t, bobHb);
  assert.equal(wrong.status, 204, 'placement stays on the shared resource');
  const right = await readJson(await lease(s.t, s.hb));
  assert.equal(right.status, 200, right.text);
});

// Lease-time authority: a job queued under a live grant must not be handed to
// the exporter's worker once that authority is gone. Before CLAUDE135 the
// lease re-checked nothing, so exporter compute ran for a revoked recipient
// (the result was withheld only afterwards).
async function queued(label) {
  const s = await setup();
  const adm = await admitWith(s.t, B(s.bobKey.secret));
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitWith(s.t, B(s.bobKey.secret), adm.json, `bob-queued-${label}`);
  assert.equal(sub.status, 202, sub.text);
  return s;
}

const narrowings = {
  revoked: async (s) => {
    const r = await readJson(await s.t.call(`/v1/fabric/grants/${s.grantId}/revoke`, {
      method: 'POST', headers: S(s.t, s.t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 },
    }));
    assert.equal(r.status, 200, r.text);
  },
  paused: async (s) => {
    const r = await readJson(await s.t.call(`/v1/fabric/grants/${s.grantId}/pause`, {
      method: 'POST', headers: S(s.t, s.t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 },
    }));
    assert.equal(r.status, 200, r.text);
  },
  suspended: async (s) => {
    await s.t.DB.prepare("UPDATE connections SET state = 'suspended' WHERE id = ?").bind(s.pair.conn.id).run();
  },
  denied: async (s) => {
    const r = await readJson(await s.t.call('/v1/fabric/denies', {
      method: 'POST', headers: S(s.t, s.t.alice, { 'Idempotency-Key': freshKey() }),
      body: { principal: 'u_bob', resourceId: RES, action: 'infer' },
    }));
    assert.equal(r.status, 201, r.text);
  },
  expired: async (s) => {
    await s.t.DB.prepare('UPDATE fabric_grants SET expiry = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), s.grantId).run();
  },
};

for (const [label, narrow] of Object.entries(narrowings)) {
  test(`queued share job is not leased to the exporter worker once ${label}`, async () => {
    const s = await queued(label);
    await narrow(s);
    const l = await lease(s.t, s.hb);
    assert.equal(l.status, 204, `a ${label} grant must not route to the worker: ${await l.text()}`);
    assert.equal(await count(s.t, "SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'leased'"), 0);
  });
}

test('lease skips an unauthorized queued job and still serves a live one behind it', async () => {
  const s = await queued('mixed');
  // The exporter's own job queued behind the share job stays leasable.
  s.t.env.INFERENCE_OWNER_DAILY_TOKENS = '10000';
  const own = await admitWith(s.t, S(s.t, s.t.alice));
  assert.equal(own.status, 201, own.text);
  const ownSub = await submitWith(s.t, S(s.t, s.t.alice), own.json, 'alice-own-op-0001');
  assert.equal(ownSub.status, 202, ownSub.text);
  await narrowings.revoked(s);
  const l = await readJson(await lease(s.t, s.hb));
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.job_id, ownSub.json.job_id, 'the revoked share job is skipped, not served');
  const none = await lease(s.t, s.hb);
  assert.equal(none.status, 204);
});
