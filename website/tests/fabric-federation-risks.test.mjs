// CLAUDE135 source-inspected federation risks, reproduced as targeted tests
// on the real local D1 store and real routes (synthetic principals only):
//   R1 fixture-route consent must not become live internal execution
//   R2 grant expiry after admission and before release
//   R3 FEDERATION_ENABLED x INFERENCE_ENABLED truth table (incl. in-flight)
//   R4 concurrent first requests sharing one idempotency key
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricEnv, connectPair, S, freshKey, readJson } from './qa-helpers.mjs';

const RES = 'r_gpu1';
const MODEL = 'llama';
const B = (secret) => ({ Authorization: `Bearer ${secret}` });
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// Exporter consent with an explicit route term. route undefined = the
// historical default preview (fixture).
async function share(t, connId, { route, consumers = ['u_bob'], models = [MODEL] } = {}) {
  const body = { connectionId: connId, resourceIds: [RES], consumers, models, maxTokens: 1000, maxRequests: 10 };
  if (route !== undefined) body.route = route;
  const prev = await readJson(await t.call('/v1/fabric/previews', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body }));
  if (prev.status !== 201) return { prev };
  const appr = await readJson(await t.call('/v1/fabric/approvals', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { previewId: prev.json.id } }));
  assert.equal(appr.status, 201, appr.text);
  const dec = await readJson(await t.call(`/v1/fabric/approvals/${appr.json.id}/decide`, { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { decision: 'approve' } }));
  assert.equal(dec.status, 200, dec.text);
  const grant = await readJson(await t.call('/v1/fabric/grants', { method: 'POST', headers: S(t, t.alice, { 'Idempotency-Key': freshKey() }), body: { approvalId: appr.json.id, previewHash: prev.json.digest } }));
  assert.equal(grant.status, 201, grant.text);
  return { prev, grant: grant.json };
}

async function heartbeat(t) {
  const key = await readJson(await t.call('/api/keys', { method: 'POST', headers: S(t, t.alice), body: { name: 'hb', scope: 'heartbeat', resourceId: RES } }));
  assert.equal(key.status, 201, key.text);
  const beat = await t.call(`/api/resources/${RES}/heartbeat`, { method: 'POST', headers: B(key.json.secret), body: { usable: true } });
  assert.equal(beat.status, 200, await beat.text());
  return key.json.secret;
}

const admit = async (t, headers) => readJson(await t.call('/api/inference/admissions', {
  method: 'POST', headers, body: { resource_id: RES, model_id: MODEL, max_tokens: 100 },
}));
const submit = async (t, headers, admission, key) => readJson(await t.call('/api/jobs', {
  method: 'POST', headers,
  body: { contract_version: 'v1.0.0', admission_ref: admission.admission_ref, idempotency_key: key,
    model_id: MODEL, prompt: 'Reply with exactly: hello', max_tokens: 100, deadline_at: Date.now() + 60000 },
}));
const succeeded = (l) => ({
  lease_id: l.lease_id, status: 'succeeded',
  result: { request_id: l.job_id, node_id: l.envelope.task.placement.node_id,
    runtime_id: l.envelope.task.placement.runtime_id, model_id: l.envelope.task.model_id,
    runtime_instance: l.envelope.binding.runtime_instance, model_fingerprint: l.envelope.binding.model_fingerprint,
    simulated: false, content: 'hello', finish_reason: 'stop', elapsed_ms: 9, usage: { output_tokens: 1 }, cache: {} },
});
const count = async (t, sql, ...b) => (await t.DB.prepare(sql).bind(...b).first()).n;

async function base({ route = 'internal' } = {}) {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  const pair = await connectPair(t);
  const s = await share(t, pair.conn.id, { route: route === 'default' ? undefined : route });
  const hb = await heartbeat(t);
  return { t, pair, grantId: s.grant && s.grant.id, prev: s.prev, hb };
}

// ---- R1 ---------------------------------------------------------------
test('R1: a default (fixture-route) consent authorizes no live execution', async () => {
  const s = await base({ route: 'default' });
  assert.equal(s.prev.json.preview.route, 'fixture', 'historical default preview route');
  const r = await admit(s.t, S(s.t, s.t.bob));
  assert.equal(r.status, 404, `fixture consent must not mint a live admission: ${r.text}`);
  assert.equal(await count(s.t, 'SELECT COUNT(*) AS n FROM dispatch_admissions'), 0);
});

test('R1: an explicit internal-route consent is named in the preview and executes', async () => {
  const s = await base({ route: 'internal' });
  assert.equal(s.prev.json.preview.route, 'internal');
  assert.match(s.prev.json.confirmation, /live inference/i, 'the human confirmation names live execution');
  const r = await admit(s.t, S(s.t, s.t.bob));
  assert.equal(r.status, 201, r.text);
});

test('R1: unknown route terms are refused at preview, never coerced', async () => {
  const t = await fabricEnv();
  const pair = await connectPair(t);
  for (const route of ['external', '', 7, null]) {
    const s = await share(t, pair.conn.id, { route });
    assert.equal(s.prev.status, 400, `${JSON.stringify(route)}: ${s.prev.text}`);
    assert.equal(s.prev.json.code, 'BAD_ROUTE');
  }
});

// ---- R2 ---------------------------------------------------------------
test('R2: an admission never outlives the grant time window', async () => {
  const s = await base();
  const expiry = Date.now() + 90_000;
  await s.t.DB.prepare('UPDATE fabric_grants SET expiry = ? WHERE id = ?').bind(new Date(expiry).toISOString(), s.grantId).run();
  const r = await admit(s.t, S(s.t, s.t.bob));
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.expires_at <= expiry,
    `admission expires_at ${r.json.expires_at} must not exceed grant expiry ${expiry}`);
  // Hence the job deadline (<= admission expiry), the lease (deadline ahead)
  // and the result intake (not late) all fall inside the consented window.
  const sub = await submit(s.t, S(s.t, s.t.bob), r.json, 'bob-r2-window-0001');
  assert.equal(sub.status, 202, sub.text);
  const job = await s.t.DB.prepare('SELECT deadline_at FROM dispatch_jobs').first();
  assert.ok(Number(job.deadline_at) <= expiry, 'job deadline stays inside the grant window');
});

test('R2: work completed inside the window releases; nothing starts after it', async () => {
  const s = await base();
  const adm = await admit(s.t, S(s.t, s.t.bob));
  const sub = await submit(s.t, S(s.t, s.t.bob), adm.json, 'bob-r2-release-01');
  assert.equal(sub.status, 202, sub.text);
  const l = await readJson(await s.t.call('/api/worker/jobs/next', { headers: B(s.hb) }));
  assert.equal(l.status, 200, l.text);
  const posted = await readJson(await s.t.call(`/api/worker/jobs/${l.json.job_id}/result`, { method: 'POST', headers: B(s.hb), body: succeeded(l.json) }));
  assert.equal(posted.status, 200, posted.text);
  // Window ends after the in-window result: the settled content still
  // releases (charged reservation, delivered once), and a new admission fails.
  await s.t.DB.prepare('UPDATE fabric_grants SET expiry = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), s.grantId).run();
  const out = await readJson(await s.t.call('/api/jobs/bob-r2-release-01', { headers: S(s.t, s.t.bob) }));
  assert.equal(out.json.status, 'settled');
  assert.equal(out.json.outcome.content, 'hello');
  const again = await admit(s.t, S(s.t, s.t.bob));
  assert.equal(again.status, 404, again.text);
});

// ---- R3 ---------------------------------------------------------------
for (const [fed, inf] of [['1', '1'], ['', '1'], ['1', ''], ['', '']]) {
  test(`R3: FEDERATION_ENABLED=${fed || 'unset'} INFERENCE_ENABLED=${inf || 'unset'}`, async () => {
    const s = await base();
    s.t.env.INFERENCE_OWNER_DAILY_TOKENS = '10000';
    if (fed) s.t.env.FEDERATION_ENABLED = fed; else delete s.t.env.FEDERATION_ENABLED;
    if (inf) s.t.env.INFERENCE_ENABLED = inf; else delete s.t.env.INFERENCE_ENABLED;
    const nodes = await s.t.call('/v1/fabric/nodes', { headers: S(s.t, s.t.bob) });
    assert.equal(nodes.status, fed ? 200 : 404, 'fabric control plane follows FEDERATION_ENABLED only');
    const cross = await admit(s.t, S(s.t, s.t.bob));
    const own = await admit(s.t, S(s.t, s.t.alice));
    if (fed && inf) {
      assert.equal(cross.status, 201, cross.text);
      assert.equal(own.status, 201, own.text);
    } else if (inf) {
      assert.equal(cross.status, 404, `federation off: a committed share must not execute: ${cross.text}`);
      assert.equal(own.status, 201, 'owner execution is independent of federation');
    } else {
      assert.notEqual(cross.status, 201, cross.text);
      assert.notEqual(own.status, 201, own.text);
    }
    const n = await count(s.t, "SELECT COUNT(*) AS n FROM dispatch_admissions WHERE principal_id = 'u_bob'");
    assert.equal(n, fed && inf ? 1 : 0, 'cross-owner admissions exist only with both flags on');
  });
}

test('R3: turning federation off stops queued share work and withholds in-flight results', async () => {
  const s = await base();
  const a1 = await admit(s.t, S(s.t, s.t.bob));
  const j1 = await submit(s.t, S(s.t, s.t.bob), a1.json, 'bob-r3-leased-001');
  assert.equal(j1.status, 202, j1.text);
  const l = await readJson(await s.t.call('/api/worker/jobs/next', { headers: B(s.hb) }));
  assert.equal(l.status, 200, l.text);
  const a2 = await admit(s.t, S(s.t, s.t.bob));
  const j2 = await submit(s.t, S(s.t, s.t.bob), a2.json, 'bob-r3-queued-001');
  assert.equal(j2.status, 202, j2.text);

  delete s.t.env.FEDERATION_ENABLED;
  const next = await s.t.call('/api/worker/jobs/next', { headers: B(s.hb) });
  assert.equal(next.status, 204, 'queued share work is not handed to the exporter worker');
  // F1: the flag-off pause must not burn the queued job. It stays queued
  // (never terminal) with the reservation untouched until the flag returns.
  const q = await s.t.DB.prepare('SELECT status FROM dispatch_jobs WHERE job_id = ?').bind(j2.json.job_id).first();
  assert.equal(q.status, 'queued', 'flag-off leaves the queued share job queued, not expired');
  assert.equal(await count(s.t, "SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'expired'"), 0);
  const spendPaused = await s.t.DB.prepare('SELECT used_tokens, used_jobs FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
  const posted = await readJson(await s.t.call(`/api/worker/jobs/${l.json.job_id}/result`, { method: 'POST', headers: B(s.hb), body: succeeded(l.json) }));
  assert.equal(posted.status, 200, posted.text);
  const out = await readJson(await s.t.call('/api/jobs/bob-r3-leased-001', { headers: S(s.t, s.t.bob) }));
  assert.equal(out.json.status, 'settled');
  assert.equal(out.json.outcome?.content, undefined, 'federation off releases no share content');
  // Restoring the flag resumes the paused job: it leases only because the
  // grant is still authorized and the deadline still ahead, then releases.
  s.t.env.FEDERATION_ENABLED = '1';
  const resumed = await readJson(await s.t.call('/api/worker/jobs/next', { headers: B(s.hb) }));
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.job_id, j2.json.job_id, 'the paused job leases after restore');
  const posted2 = await readJson(await s.t.call(`/api/worker/jobs/${resumed.json.job_id}/result`, { method: 'POST', headers: B(s.hb), body: succeeded(resumed.json) }));
  assert.equal(posted2.status, 200, posted2.text);
  const out2 = await readJson(await s.t.call('/api/jobs/bob-r3-queued-001', { headers: S(s.t, s.t.bob) }));
  assert.equal(out2.json.status, 'settled');
  assert.equal(out2.json.outcome.content, 'hello', 'restored federation releases the paused result');
  const spendAfter = await s.t.DB.prepare('SELECT used_tokens, used_jobs FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
  assert.deepEqual(spendAfter, spendPaused, 'the pause itself charges nothing extra');
});

test('R3: a revoke or expiry during the flag-off pause never revives after restore', async () => {
  for (const label of ['revoked', 'expired']) {
    const s = await base();
    const a = await admit(s.t, S(s.t, s.t.bob));
    assert.equal(a.status, 201, a.text);
    const key = `bob-r3-pause-${label}`;
    const j = await submit(s.t, S(s.t, s.t.bob), a.json, key);
    assert.equal(j.status, 202, j.text);
    delete s.t.env.FEDERATION_ENABLED;
    const next = await s.t.call('/api/worker/jobs/next', { headers: B(s.hb) });
    assert.equal(next.status, 204, `${label}: paused share work is not handed out`);
    const q = await s.t.DB.prepare('SELECT status FROM dispatch_jobs WHERE job_id = ?').bind(j.json.job_id).first();
    assert.equal(q.status, 'queued', `${label}: still queued while paused`);
    // Narrow authority while paused. The /v1/fabric control plane is itself
    // flag-gated, so the fixture writes the same terminal grant state the
    // route would (status row for revoke, window end for expiry).
    if (label === 'revoked') {
      await s.t.DB.prepare("UPDATE fabric_grants SET status = 'revoked' WHERE id = ?").bind(s.grantId).run();
    } else {
      await s.t.DB.prepare('UPDATE fabric_grants SET expiry = ? WHERE id = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), s.grantId).run();
    }
    const spendBefore = await s.t.DB.prepare('SELECT used_tokens, used_jobs FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
    s.t.env.FEDERATION_ENABLED = '1';
    const after = await s.t.call('/api/worker/jobs/next', { headers: B(s.hb) });
    assert.equal(after.status, 204, `${label}: stale authority never revives into a lease`);
    assert.equal(await count(s.t, "SELECT COUNT(*) AS n FROM dispatch_jobs WHERE status = 'leased'"), 0);
    const row = await s.t.DB.prepare('SELECT status, result_json FROM dispatch_jobs WHERE job_id = ?').bind(j.json.job_id).first();
    assert.equal(row.status, 'expired', `${label}: the job is terminal, not uncertain`);
    assert.equal(JSON.parse(row.result_json).reason, 'authority_lost');
    const out = await readJson(await s.t.call(`/api/jobs/${key}`, { headers: S(s.t, s.t.bob) }));
    assert.equal(out.json.status, 'settled', out.text);
    assert.equal(out.json.outcome.finish, 'expired');
    assert.equal(out.json.outcome.content, undefined, `${label}: nothing releases`);
    const spendAfter = await s.t.DB.prepare('SELECT used_tokens, used_jobs FROM fabric_grants WHERE id = ?').bind(s.grantId).first();
    assert.deepEqual(spendAfter, spendBefore, `${label}: the reservation stays as charged`);
  }
});

// ---- R4 ---------------------------------------------------------------
async function ownerModelEnv() {
  const t = await fabricEnv();
  t.env.INFERENCE_ENABLED = '1';
  t.env.INFERENCE_OWNER_DAILY_TOKENS = '10000';
  const hb = await heartbeat(t);
  const cap = await readJson(await t.call(`/api/resources/${RES}/capabilities`, {
    method: 'POST', headers: B(hb),
    body: { schema_version: 1, os: 'fixture-os', arch: 'fixture-arch',
      runtimes: [{ name: 'llama-server', formats: ['gguf'], models: [MODEL] }],
      mem: { ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 4 * 1024 ** 3 },
      disk: { totalBytes: 100 * 1024 ** 3, availBytes: 50 * 1024 ** 3 }, workload: {} },
  }));
  assert.equal(cap.status, 200, cap.text);
  return { t, hb };
}

test('R4: concurrent first requests with one idempotency key converge on one operation', async () => {
  const { t, hb } = await ownerModelEnv();
  const headers = { ...S(t, t.alice), 'Idempotency-Key': 'r4-same-key-000001' };
  const body = { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'r4 says hi' }] };
  const p1 = t.call('/v1/chat/completions', { method: 'POST', headers, body });
  const p2 = t.call('/v1/chat/completions', { method: 'POST', headers, body });
  await SLEEP(300);
  const l = await readJson(await t.call('/api/worker/jobs/next', { headers: B(hb) }));
  assert.equal(l.status, 200, l.text);
  const posted = await readJson(await t.call(`/api/worker/jobs/${l.json.job_id}/result`, { method: 'POST', headers: B(hb), body: succeeded(l.json) }));
  assert.equal(posted.status, 200, posted.text);
  const [r1, r2] = await Promise.all([readJson(await p1), readJson(await p2)]);
  for (const r of [r1, r2]) {
    assert.notEqual(r.json?.error?.code, 'idempotency_conflict', `same payload must never conflict: ${r.text}`);
  }
  assert.ok([r1, r2].some((r) => r.status === 200), 'one caller receives the completion');
  for (const r of [r1, r2]) assert.ok([200, 409].includes(r.status), r.text);
  assert.equal(await count(t, 'SELECT COUNT(*) AS n FROM dispatch_operations'), 1, 'one durable operation');
  assert.equal(await count(t, 'SELECT COUNT(*) AS n FROM dispatch_jobs'), 1, 'one job');
  const extra = await t.call('/api/worker/jobs/next', { headers: B(hb) });
  assert.equal(extra.status, 204);
});

test('R4: concurrent requests with one key but different payloads still conflict, never execute twice', async () => {
  const { t, hb } = await ownerModelEnv();
  const headers = { ...S(t, t.alice), 'Idempotency-Key': 'r4-diff-key-000001' };
  const mk = (content) => ({ model: MODEL, max_tokens: 64, messages: [{ role: 'user', content }] });
  const p1 = t.call('/v1/chat/completions', { method: 'POST', headers, body: mk('first') });
  const p2 = t.call('/v1/chat/completions', { method: 'POST', headers, body: mk('second') });
  await SLEEP(300);
  const l = await readJson(await t.call('/api/worker/jobs/next', { headers: B(hb) }));
  assert.equal(l.status, 200, l.text);
  await t.call(`/api/worker/jobs/${l.json.job_id}/result`, { method: 'POST', headers: B(hb), body: succeeded(l.json) });
  const rs = await Promise.all([readJson(await p1), readJson(await p2)]);
  assert.equal(rs.filter((r) => r.json?.error?.code === 'idempotency_conflict').length, 1, rs.map((r) => r.text).join(' | '));
  assert.equal(await count(t, 'SELECT COUNT(*) AS n FROM dispatch_jobs'), 1);
});
