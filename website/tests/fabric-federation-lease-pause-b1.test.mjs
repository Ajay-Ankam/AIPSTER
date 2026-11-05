// B1 (independent PR #115 review of 21da6dc): while FEDERATION_ENABLED is
// off, queued share jobs are paused (left queued, F1). The lease scan took
// only the first LEASE_SCAN_LIMIT queued jobs and skipped paused ones, so
// >= LEASE_SCAN_LIMIT paused share jobs ahead of the exporter's own job hid
// it from the worker until those jobs reached their deadlines.
// Real routes, local D1 shim, synthetic principals, fixture worker only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, S, freshKey, readJson } from './qa-helpers.mjs';

const RES = 'r_gpu1';
const MODEL = 'llama';
const SHARE_JOBS = 17; // above the 16-row lease scan window
const B = (secret) => ({ Authorization: `Bearer ${secret}` });

async function share(t, connId) {
  const body = { connectionId: connId, resourceIds: [RES], consumers: ['u_bob'], models: [MODEL],
    maxTokens: 100000, maxRequests: 100, route: 'internal' };
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body }));
  assert.equal(prev.status, 201, prev.text);
  const appr = await readJson(await t.call('/v1/fabric/approvals', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { previewId: prev.json.id } }));
  assert.equal(appr.status, 201, appr.text);
  const dec = await readJson(await t.call(`/v1/fabric/approvals/${appr.json.id}/decide`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  assert.equal(dec.status, 200, dec.text);
  const grant = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(grant.status, 201, grant.text);
  return grant.json;
}

async function heartbeat(t) {
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: S(t, t.alice), body: { name: 'hb', scope: 'heartbeat', resourceId: RES } }));
  assert.equal(key.status, 201, key.text);
  const beat = await t.call(`/api/resources/${RES}/heartbeat`, { method: 'POST', headers: B(key.json.secret), body: { usable: true } });
  assert.equal(beat.status, 200, await beat.text());
  return key.json.secret;
}

async function queueJob(t, headers, key) {
  const a = await readJson(await t.call('/api/inference/admissions', {
    method: 'POST', headers, body: { resource_id: RES, model_id: MODEL, max_tokens: 100 } }));
  assert.equal(a.status, 201, a.text);
  const j = await readJson(await t.call('/api/jobs', { method: 'POST', headers,
    body: { contract_version: 'v1.0.0', admission_ref: a.json.admission_ref, idempotency_key: key,
      model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100, deadline_at: Date.now() + 60000 } }));
  assert.equal(j.status, 202, j.text);
  return j.json.job_id;
}

test('B1: a federation pause never hides the exporter\'s own job behind paused share jobs', async () => {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  t.env.INFERENCE_OWNER_DAILY_TOKENS = '100000';
  const pair = await connectPair(t);
  const grant = await share(t, pair.conn.id);
  const hb = await heartbeat(t);

  const shareJobs = [];
  for (let i = 0; i < SHARE_JOBS; i += 1) {
    shareJobs.push(await queueJob(t, S(t, t.bob), `bob-b1-share-${String(i).padStart(4, '0')}`));
  }
  const ownerJob = await queueJob(t, S(t, t.alice), 'alice-b1-owner-0001');
  const spendBefore = await t.DB.prepare('SELECT used_tokens, used_jobs FROM fabric_grants WHERE id = ?').bind(grant.id).first();

  delete t.env.FEDERATION_ENABLED; // operator pause
  const l = await readJson(await t.call('/api/worker/jobs/next', { headers: B(hb) }));
  assert.equal(l.status, 200, `the owner job must stay leasable during the pause: ${l.text}`);
  assert.equal(l.json.job_id, ownerJob, 'only the exporter\'s own job is leased while paused');

  // No share job is handed out while paused, and none is burned.
  const next = await t.call('/api/worker/jobs/next', { headers: B(hb) });
  assert.equal(next.status, 204, 'paused share jobs are never leased');
  const statuses = await t.DB.prepare(`SELECT status, COUNT(*) AS n FROM dispatch_jobs
    WHERE job_id IN (${shareJobs.map(() => '?').join(',')}) GROUP BY status`).bind(...shareJobs).all();
  assert.deepEqual(statuses.results.map((r) => [r.status, r.n]), [['queued', SHARE_JOBS]]);
  const spendPaused = await t.DB.prepare('SELECT used_tokens, used_jobs FROM fabric_grants WHERE id = ?').bind(grant.id).first();
  assert.deepEqual(spendPaused, spendBefore, 'the pause charges nothing');

  // Restoring the flag resumes share work in queue order.
  t.env.FEDERATION_ENABLED = '1';
  const resumed = await readJson(await t.call('/api/worker/jobs/next', { headers: B(hb) }));
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.job_id, shareJobs[0], 'the oldest paused share job leases first after restore');
});
