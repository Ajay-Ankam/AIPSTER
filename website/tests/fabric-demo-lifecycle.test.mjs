// Federation execution demo lifecycle: ONE explicitly authorized sharing
// relationship (alice exports r_gpu1, bob consumes via a consented fabric
// grant) driven through the real routes on the real D1 store:
// consent -> admit -> submit -> lease -> worker result -> settle, then a
// stranger denial and a revocation that blocks subsequent use. The worker
// side is played by this test with the canonical wire shapes (no engine,
// no network); the live real-inference counterpart is the /tmp proof
// harness referenced in the Agent B handoff, not this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fabricEnv, connectPair, commitFlow, S, readJson } from './qa-helpers.mjs';

const RES = 'r_gpu1';
const MODEL = 'llama';

async function setup() {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  const pair = await connectPair(t);
  const flow = await commitFlow(t, pair.conn.id, [RES], ['u_bob'], { route: 'internal' });
  const grantId = flow.grant.id;
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

async function seedStranger(t) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 12 * 3600e3).toISOString();
  await t.DB.prepare('INSERT INTO allowlist (email, added_at) VALUES (?, ?)')
    .bind('carol@example.com', now).run();
  await t.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('u_carol', 'Carol', 'carol@example.com', 1, null, now, now).run();
  const token = randomBytes(32).toString('hex');
  await t.DB.prepare('INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(`s_${token.slice(0, 8)}`, future, token, now, now, null, 'test', 'u_carol').run();
  return { id: 'u_carol', name: 'Carol', email: 'carol@example.com', token };
}

const admit = async (s, user, body = {}) => readJson(await s.t.call('/api/inference/admissions', {
  method: 'POST', headers: S(s.t, user),
  body: { resource_id: RES, model_id: MODEL, max_tokens: 100, ...body },
}));
const submitAs = async (s, user, admission, key) => readJson(await s.t.call('/api/jobs', {
  method: 'POST', headers: S(s.t, user),
  body: { contract_version: 'v1.0.0', admission_ref: admission.admission_ref, idempotency_key: key,
    model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100, deadline_at: Date.now() + 60000 },
}));
const K = (s) => ({ Authorization: `Bearer ${s.hb}` });
const succeeded = (lease, content = 'hello') => ({
  lease_id: lease.lease_id, status: 'succeeded',
  result: { request_id: lease.job_id, node_id: lease.envelope.task.placement.node_id,
    runtime_id: lease.envelope.task.placement.runtime_id, model_id: MODEL,
    runtime_instance: lease.envelope.binding.runtime_instance,
    model_fingerprint: lease.envelope.binding.model_fingerprint,
    simulated: false, content, elapsed_ms: 9, usage: { output_tokens: 1 }, cache: {} },
});
const spent = async (s) => {
  const r = await s.t.DB.prepare('SELECT used_tokens AS n, used_jobs AS j FROM fabric_grants WHERE id = ?')
    .bind(s.grantId).first();
  return { n: r.n, j: r.j };
};

test('demo lifecycle: one consented share executes and releases content once', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob);
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitAs(s, s.t.bob, adm.json, 'bob-demo-lifecycle-01');
  assert.equal(sub.status, 202, sub.text);
  assert.equal(sub.json.status, 'dispatched');

  const lease = await readJson(await s.t.call('/api/worker/jobs/next', { headers: K(s) }));
  assert.equal(lease.status, 200, lease.text);
  assert.equal(lease.json.job_id, sub.json.job_id);
  const posted = await readJson(await s.t.call(`/api/worker/jobs/${lease.json.job_id}/result`, {
    method: 'POST', headers: K(s), body: succeeded(lease.json),
  }));
  assert.equal(posted.status, 200, posted.text);

  const settled = await readJson(await s.t.call('/api/jobs/bob-demo-lifecycle-01', { headers: S(s.t, s.t.bob) }));
  assert.equal(settled.status, 200, settled.text);
  assert.equal(settled.json.status, 'settled');
  assert.equal(settled.json.outcome.content, 'hello');
  assert.equal(settled.json.outcome.provenance.simulated, false);
  const again = await readJson(await s.t.call('/api/jobs/bob-demo-lifecycle-01', { headers: S(s.t, s.t.bob) }));
  assert.equal(again.json.status, 'settled');
  assert.equal(again.json.outcome?.content, undefined, 'content is released once');
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'exactly-once charge on the fabric grant');
});

test('demo lifecycle: a stranger with no grant is denied without disclosure', async () => {
  const s = await setup();
  const carol = await seedStranger(s.t);
  const denied = await admit(s, carol);
  assert.equal(denied.status, 404, denied.text);
  assert.equal(denied.json.code, 'NOT_FOUND');
  const rows = await s.t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = ?')
    .bind('u_carol').first();
  assert.equal(rows.n, 0, 'a denied stranger mints no admission');
  const jobs = await s.t.DB.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').bind().first();
  assert.equal(jobs.n, 0, 'a denied stranger queues no job');
});

test('demo lifecycle: revocation withholds in-flight content and blocks subsequent use', async () => {
  const s = await setup();
  const adm = await admit(s, s.t.bob);
  assert.equal(adm.status, 201, adm.text);
  const sub = await submitAs(s, s.t.bob, adm.json, 'bob-demo-lifecycle-02');
  assert.equal(sub.status, 202, sub.text);
  const lease = await readJson(await s.t.call('/api/worker/jobs/next', { headers: K(s) }));
  assert.equal(lease.status, 200, lease.text);

  // Owner revokes through the real fabric route while the job is leased.
  const rev = await readJson(await s.t.call(`/v1/fabric/grants/${s.grantId}/revoke`, {
    method: 'POST',
    headers: S(s.t, s.t.alice, { 'Idempotency-Key': 'demo-revoke-00000001' }),
    body: { expectedVersion: 1 },
  }));
  assert.equal(rev.status, 200, rev.text);

  // The worker's already-leased result still posts, but reconcile withholds
  // the content: the authority died before release. The hold stays charged.
  const posted = await readJson(await s.t.call(`/api/worker/jobs/${lease.json.job_id}/result`, {
    method: 'POST', headers: K(s), body: succeeded(lease.json),
  }));
  assert.equal(posted.status, 200, posted.text);
  const settled = await readJson(await s.t.call('/api/jobs/bob-demo-lifecycle-02', { headers: S(s.t, s.t.bob) }));
  assert.equal(settled.json.status, 'settled');
  assert.equal(settled.json.outcome?.content, undefined, 'revoked authority releases no content');
  assert.equal(settled.json.outcome.withheld_reason, 'authority_revoked_before_release');
  assert.deepEqual(await spent(s), { n: 100, j: 1 }, 'withheld yet charged, exactly once');

  // Subsequent use is blocked: re-admission reads as no live grant, and the
  // pre-revocation admission cannot start new work.
  const again = await admit(s, s.t.bob);
  assert.equal(again.status, 404, again.text);
  assert.equal(again.json.code, 'NOT_FOUND');
  const resub = await submitAs(s, s.t.bob, adm.json, 'bob-demo-lifecycle-03');
  assert.equal(resub.json.status, 'rejected', resub.text);
});
