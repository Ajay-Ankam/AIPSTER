// CLAUDE135 G3: grant-derived OpenAI candidates. A recipient's own inference
// key reaches /v1/models and /v1/chat/completions on an exporter's resource
// ONLY through a live, explicitly route-'internal' fabric share; owner-only
// tenant isolation in model-readiness stays intact. Synthetic principals on
// the real local D1 store and real worker.js routes; the exporter worker is
// played with the canonical lease/result wire (no engine, no network).
// model_fingerprint/runtime_instance in these fixtures are worker-reported
// labels, not attestation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fabricEnv, connectPair, commitFlow, S, freshKey, readJson } from './qa-helpers.mjs';
import { qualifySnapshot } from '../src/inference/model-readiness.mjs';
import { listSharedSnapshots } from '../src/inference/fabric-openai-route.mjs';

const RES = 'r_gpu1';
const MODEL = 'llama';
const B = (secret) => ({ Authorization: `Bearer ${secret}` });
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const count = async (t, sql, ...b) => (await t.DB.prepare(sql).bind(...b).first()).n;

async function addResource(t, id, owner) {
  const now = new Date().toISOString();
  await t.DB.prepare(`INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, capabilities_json, configured, authenticated, online, usable, heartbeat_at, limits_json, scope, verification_json, credits_json, created_at)
    VALUES (?,?,?,'local','declared','x','y','[]',1,0,0,0,NULL,'{}','owner only','{}',NULL,?)`).bind(id, owner, id, now).run();
}

async function worker(t, user, resourceId, models) {
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: S(t, user), body: { name: `hb-${resourceId}`, scope: 'heartbeat', resourceId } }));
  assert.equal(key.status, 201, key.text);
  const hb = key.json.secret;
  const beat = await t.call(`/api/resources/${resourceId}/heartbeat`, { method: 'POST', headers: B(hb), body: { usable: true } });
  assert.equal(beat.status, 200, await beat.text());
  const cap = await readJson(await t.call(`/api/resources/${resourceId}/capabilities`, {
    method: 'POST', headers: B(hb),
    body: { schema_version: 1, os: 'fixture-os', arch: 'fixture-arch',
      runtimes: [{ name: 'llama-server', formats: ['gguf'], models }],
      mem: { ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 4 * 1024 ** 3 },
      disk: { totalBytes: 100 * 1024 ** 3, availBytes: 50 * 1024 ** 3 }, workload: {} },
  }));
  assert.equal(cap.status, 200, cap.text);
  return hb;
}

async function seedCarol(t) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 12 * 3600e3).toISOString();
  await t.DB.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)').bind('carol@example.com', now).run();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('u_carol', 'Carol', 'carol@example.com', 1, null, now, now).run();
  const token = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`s_${token.slice(0, 8)}`, future, token, now, now, null, 'test', 'u_carol').run();
  return { id: 'u_carol', token };
}

// alice exports r_gpu1 (serving llama + other-model) with consent for llama
// only; r_gpu2 (alice, unshared) serves secret-model.
async function setup({ route = 'internal' } = {}) {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  const pair = await connectPair(t);
  const flow = await commitFlow(t, pair.conn.id, [RES], ['u_bob'], { route: route === 'default' ? undefined : route });
  const hb = await worker(t, t.alice, RES, [MODEL, 'other-model']);
  await addResource(t, 'r_gpu2', 'u_alice');
  await worker(t, t.alice, 'r_gpu2', ['secret-model']);
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: S(t, t.bob), body: { name: 'bob-inf', scope: 'inference' } }));
  assert.equal(key.status, 201, key.text);
  return { t, pair, grantId: flow.grant.id, hb, bob: key.json.secret };
}

const models = async (t, headers) => readJson(await t.call('/v1/models', { method: 'GET', headers }));
const chat = (t, headers, key, body = {}) => t.call('/v1/chat/completions', {
  method: 'POST', headers: { ...headers, 'Idempotency-Key': key },
  body: { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'g3 says hi' }], ...body },
});
const succeeded = (l) => ({
  lease_id: l.lease_id, status: 'succeeded',
  result: { request_id: l.job_id, node_id: l.envelope.task.placement.node_id,
    runtime_id: l.envelope.task.placement.runtime_id, model_id: l.envelope.task.model_id,
    runtime_instance: l.envelope.binding.runtime_instance, model_fingerprint: l.envelope.binding.model_fingerprint,
    simulated: false, content: 'hello from the share', finish_reason: 'stop', elapsed_ms: 9, usage: { output_tokens: 4 }, cache: {} },
});
async function serveOne(t, hb) {
  await SLEEP(300);
  const l = await readJson(await t.call('/api/worker/jobs/next', { headers: B(hb) }));
  assert.equal(l.status, 200, l.text);
  const posted = await readJson(await t.call(`/api/worker/jobs/${l.json.job_id}/result`, { method: 'POST', headers: B(hb), body: succeeded(l.json) }));
  assert.equal(posted.status, 200, posted.text);
  return l.json;
}

test('G3: recipient key lists only consented shared models, with no identity leak', async () => {
  const s = await setup();
  const m = await models(s.t, B(s.bob));
  assert.equal(m.status, 200, m.text);
  assert.deepEqual(m.json.data.map((d) => d.id), [MODEL]);
  for (const leak of ['r_gpu1', 'r_gpu2', 'u_alice', s.grantId, 'other-model', 'secret-model']) {
    assert.ok(!m.text.includes(leak), `models listing leaks ${leak}`);
  }
});

test('G3: recipient key chat executes on the exporter share with the grant pinned', async () => {
  const s = await setup();
  const p = chat(s.t, B(s.bob), 'g3-bob-chat-00001');
  const lease = await serveOne(s.t, s.hb);
  const r = await readJson(await p);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'hello from the share');
  assert.equal(lease.envelope.task.placement.node_id, RES, 'placed on the shared resource');
  const adm = await s.t.DB.prepare('SELECT principal_id, tenant_id, grant_id, resource_id FROM dispatch_admissions').first();
  assert.deepEqual({ ...adm }, { principal_id: 'u_bob', tenant_id: 'u_bob', grant_id: s.grantId, resource_id: RES });
  // Settlement charges the RESERVED max_tokens (64), not actual output tokens.
  const g = await s.t.DB.prepare('SELECT used_tokens AS n, used_jobs AS j FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
  assert.deepEqual({ n: g.n, j: g.j }, { n: 64, j: 1 });
  // Same-payload replay reconciles without a new admission, job or spend.
  const again = await readJson(await chat(s.t, B(s.bob), 'g3-bob-chat-00001'));
  assert.notEqual(again.json?.error?.code, 'idempotency_conflict', again.text);
  assert.equal(await count(s.t, 'SELECT COUNT(*) AS n FROM dispatch_jobs'), 1);
  const g2 = await s.t.DB.prepare('SELECT used_tokens AS n FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
  assert.equal(g2.n, 64);
});

test('G3: revocation empties discovery, refuses new chat, and withholds replayed content', async () => {
  const s = await setup();
  const p = chat(s.t, B(s.bob), 'g3-bob-chat-00002');
  await serveOne(s.t, s.hb);
  assert.equal((await readJson(await p)).status, 200);
  const rev = await readJson(await s.t.call(`/v1/fabric/grants/${s.grantId}/revoke`, {
    method: 'POST', headers: S(s.t, s.t.alice, { 'Idempotency-Key': freshKey() }), body: { expectedVersion: 1 },
  }));
  assert.equal(rev.status, 200, rev.text);
  const m = await models(s.t, B(s.bob));
  assert.deepEqual(m.json.data, []);
  const r = await readJson(await chat(s.t, B(s.bob), 'g3-bob-chat-00003'));
  assert.ok([404, 409].includes(r.status), r.text);
  assert.equal(await count(s.t, "SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = 'u_bob'"), 1, 'no new admission');
  const status = await readJson(await s.t.call('/v1/operations/g3-bob-chat-00002', { headers: B(s.bob) }));
  assert.equal(status.status, 503, status.text);
  assert.equal(status.json.error.code, 'release_withheld');
});

test('G3: strangers, fixture-only consent and federation-off see no shared candidates', async () => {
  const s = await setup();
  const carol = await seedCarol(s.t);
  const cm = await models(s.t, { ...S(s.t, carol) });
  assert.deepEqual(cm.json.data, [], cm.text);
  const cc = await readJson(await chat(s.t, S(s.t, carol), 'g3-carol-chat-001'));
  assert.ok([404, 409].includes(cc.status), cc.text);
  assert.equal(await count(s.t, "SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = 'u_carol'"), 0);

  delete s.t.env.FEDERATION_ENABLED;
  assert.deepEqual((await models(s.t, B(s.bob))).json.data, [], 'federation off lists no shared models');
  const off = await readJson(await chat(s.t, B(s.bob), 'g3-bob-chat-off01'));
  assert.ok([404, 409].includes(off.status), off.text);

  const f = await setup({ route: 'default' });
  assert.deepEqual((await models(f.t, B(f.bob))).json.data, [], 'fixture-route consent lists nothing');
});

test('G3: unconsented model, ceiling and owner precedence', async () => {
  const s = await setup();
  const other = await readJson(await chat(s.t, B(s.bob), 'g3-bob-chat-other', { model: 'other-model' }));
  assert.equal(other.status, 404, other.text);
  const big = await readJson(await chat(s.t, B(s.bob), 'g3-bob-chat-big01', { max_tokens: 2000 }));
  assert.equal(big.status, 429, big.text);
  assert.equal(big.json.error.code, 'grant_quota_exhausted');
  assert.equal(await count(s.t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);

  // Bob's own resource serving the same model wins over the share.
  s.t.env.INFERENCE_OWNER_DAILY_TOKENS = '10000';
  await addResource(s.t, 'r_bob1', 'u_bob');
  const bobHb = await worker(s.t, s.t.bob, 'r_bob1', [MODEL]);
  const p = chat(s.t, B(s.bob), 'g3-bob-chat-own01');
  const lease = await serveOne(s.t, bobHb);
  assert.equal((await readJson(await p)).status, 200);
  assert.equal(lease.envelope.task.placement.node_id, 'r_bob1');
  const g = await s.t.DB.prepare('SELECT used_jobs AS j FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
  assert.equal(g.j, 0, 'owner execution spends nothing on the share');
});

test('G3 selection boundary: foreign rows stay excluded unless bound to the grant exporter', async () => {
  const s = await setup();
  const row = { resourceId: RES, ownerId: 'u_alice', usable: true, online: true,
    heartbeatAt: new Date().toISOString(), reportedAt: new Date().toISOString(),
    runtimesJson: JSON.stringify([{ name: 'llama-server', models: [MODEL] }]) };
  // Global tenant enforcement is untouched: the recipient as tenant is refused.
  assert.equal(qualifySnapshot(row, { nowMs: Date.now(), tenantId: 'u_bob' }).excluded.code, 'TENANT_MISMATCH');
  // A share claiming an exporter that does not own the live row is dropped.
  const lying = { listLiveShares: async () => [{ grant_id: s.grantId, resource_id: RES, exporter_id: 'u_mallory', models: [MODEL], maxTokens: 1000 }] };
  assert.deepEqual(await listSharedSnapshots({ db: s.t.DB, store: lying, principalId: 'u_bob', nowMs: Date.now() }), []);
  // The caller's own resource never enters as a share.
  const self = { listLiveShares: async () => [{ grant_id: s.grantId, resource_id: RES, exporter_id: 'u_bob', models: [MODEL], maxTokens: 1000 }] };
  assert.deepEqual(await listSharedSnapshots({ db: s.t.DB, store: self, principalId: 'u_bob', nowMs: Date.now() }), []);
  // A store without share support yields no candidates (fail closed).
  assert.deepEqual(await listSharedSnapshots({ db: s.t.DB, store: {}, principalId: 'u_bob' }), []);
});

test('G3 (A4): ownership drift after the grant excludes the shared row before any admission', async () => {
  const s = await setup();
  assert.deepEqual((await models(s.t, B(s.bob))).json.data.map((d) => d.id), [MODEL]);
  const now = new Date().toISOString();
  await s.t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('u_mallory', 'Mallory', 'mallory@example.com', 1, null, now, now).run();
  await s.t.DB.prepare("UPDATE resources SET owner_id = 'u_mallory' WHERE id = ?").bind(RES).run();
  assert.deepEqual((await models(s.t, B(s.bob))).json.data, [], 'drifted row is not advertised');
  const r = await readJson(await chat(s.t, B(s.bob), 'g3-bob-drift-0001'));
  assert.ok([404, 409].includes(r.status), r.text);
  assert.equal(await count(s.t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);
});

test('G3 (A5): grant model ids must equal worker-evidenced ids exactly', async () => {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  const pair = await connectPair(t);
  await commitFlow(t, pair.conn.id, [RES], ['u_bob'], { route: 'internal' }); // consents to 'llama'
  await worker(t, t.alice, RES, ['qwen3.8-27b-atx-iq4_xs']); // evidences a different id
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: S(t, t.bob), body: { name: 'k', scope: 'inference' } }));
  assert.deepEqual((await models(t, B(key.json.secret))).json.data, []);
  for (const model of [MODEL, 'qwen3.8-27b-atx-iq4_xs']) {
    const r = await readJson(await chat(t, B(key.json.secret), `g3-mismatch-${model.length}`, { model }));
    assert.ok([404, 409].includes(r.status), r.text);
  }
  assert.equal(await count(t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);
});

test('G3: a stale exporter heartbeat or stale evidence is not selectable', async () => {
  const s = await setup();
  const old = new Date(Date.now() - 3600e3).toISOString();
  await s.t.DB.prepare('UPDATE resources SET heartbeat_at = ? WHERE id = ?').bind(old, RES).run();
  assert.deepEqual((await models(s.t, B(s.bob))).json.data, []);
  const s2 = await setup();
  await s2.t.DB.prepare('UPDATE node_capabilities SET reported_at = ? WHERE node_id = ?').bind(old, RES).run();
  assert.deepEqual((await models(s2.t, B(s2.bob))).json.data, []);
  const r = await readJson(await chat(s2.t, B(s2.bob), 'g3-bob-stale-0001'));
  assert.ok([404, 409].includes(r.status), r.text);
  assert.equal(await count(s2.t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);
});
