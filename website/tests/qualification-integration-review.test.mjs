/* Independent verification lane: qualification router/admission contract review.
 * Exercises the real handler functions (router.mjs + admission.mjs) against the
 * repo D1 shim: ownership, replay, lease binding, stale snapshot, quotas,
 * prompt hygiene, live gates. Fixture mode only: no provider calls, no keys.
 * Owned by verification lane; does not overlap qualification-*.test.mjs
 * (pure-function tests) or dgm-routing-local.test.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv } from './d1-shim.mjs';
import {
  handleQualificationPost, handleQualificationsGet, handleWorkerNext, handleWorkerResult,
} from '../src/qualification/router.mjs';
import { digestInput, normalizeProfile } from '../src/qualification/profile.mjs';
import { qualificationLiveEnabled } from '../src/qualification/constants.mjs';
import { preflightLiveRequest } from '../src/qualification/provider.mjs';

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0030_qualification.sql');

async function qualEnv(envOver = {}) {
  const t = await createTestEnv(envOver);
  t.sqlite.exec(readFileSync(MIGRATION, 'utf8'));
  return t;
}

async function seedNode(DB, { id, owner, caps = {} }) {
  const now = new Date().toISOString();
  await DB.prepare(
    'INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, owner, `n-${id}`, 'node', 'test', 'x', 'none', now).run();
  await DB.prepare(
    'INSERT INTO node_capabilities (node_id, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, now, caps.os ?? 'linux', caps.arch ?? 'x86_64',
    JSON.stringify(caps.runtimes ?? [{ name: 'ganglion', models: ['m'] }]),
    JSON.stringify(caps.mem ?? { ramTotalBytes: 8 * 1024 ** 3 }), '{}', '{}').run();
}

async function postAs(t, ownerId, nodeId, body = {}) {
  return handleQualificationPost({ db: t.DB, env: t.env, ownerId, resourceId: nodeId, body });
}

test('review: incomplete provider diagnostics persist owner-only and cannot trigger retry', async () => {
  const t = await qualEnv({ QUALIFICATION_LIVE: '1', MODEL_API_KEY: 'not-a-real-key',
    QUAL_SPEND_CAP_USD: '0.01', QUAL_OWNER_SPEND_CAP_USD: '0.01', QUAL_GLOBAL_SPEND_CAP_USD: '0.01' });
  try {
    await seedNode(t.DB, { id: 'diag', owner: 'u_alice' });
    let calls = 0;
    const args = { db: t.DB, env: t.env, ownerId: 'u_alice', resourceId: 'diag', body: { opKey: 'diag-once' },
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 123, output_tokens: 512 },
        output_text: 'must-not-persist' })); } };
    await assert.rejects(handleQualificationPost(args), e => e.code === 'PROVIDER_INCOMPLETE');
    const row = await t.DB.prepare('SELECT state, receipt_json FROM qualification_recommendations WHERE owner_id=? AND op_key=?').bind('u_alice', 'diag-once').first();
    assert.equal(row.state, 'uncertain');
    const receipt = JSON.parse(row.receipt_json);
    assert.equal(receipt.providerContact, 'responded');
    assert.equal(receipt.billing, 'unknown');
    assert.equal(receipt.provider.reason, 'max_output_tokens');
    assert.equal(receipt.provider.usage.outputTokens, 512);
    assert.equal(row.receipt_json.includes('must-not-persist'), false);
    await assert.rejects(handleQualificationPost(args));
    assert.equal(calls, 1);
    const bob = await handleQualificationsGet({ db: t.DB, ownerId: 'u_bob' });
    assert.deepEqual(bob.body.recommendations, []);
    const assignments = await t.DB.prepare('SELECT count(*) AS n FROM qualification_runs').first();
    assert.equal(assignments.n, 0);
  } finally { t.sqlite.close(); }
});

async function failsWith(fn, status, code) {
  try {
    await fn();
  } catch (e) {
    assert.equal(e?.status, status, `status (code ${e?.code})`);
    assert.equal(e?.code, code, 'code');
    return;
  }
  assert.fail(`expected ${status}/${code}`);
}

const goodResult = (leaseId) => ({
  leaseId, status: 'succeeded',
  result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 1200, promptTokens: 10, completionTokens: 32 },
});

test('review: cross-owner and grantee are denied, reports stay owner-scoped', async () => {
  const t = await qualEnv();
  await seedNode(t.DB, { id: 'res1', owner: 'u_alice' });
  await failsWith(() => postAs(t, 'u_bob', 'res1', {}), 404, 'RESOURCE_NOT_FOUND');
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO grants (id, resource_id, owner_id, grantee_id, max_jobs, max_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind('g1', 'res1', 'u_alice', 'u_bob', 1, 100, now).run();
  await failsWith(() => postAs(t, 'u_bob', 'res1', {}), 404, 'RESOURCE_NOT_FOUND');
  const seen = await handleQualificationsGet({ db: t.DB, ownerId: 'u_bob' });
  assert.deepEqual(seen.body.recommendations, []);
  assert.deepEqual(seen.body.runs, []);
});

test('review: missing capability snapshot is 409 with no spend', async () => {
  const t = await qualEnv();
  const now = new Date().toISOString();
  await t.DB.prepare(
    'INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind('bare', 'u_alice', 'n-bare', 'node', 'test', 'x', 'none', now).run();
  await failsWith(() => postAs(t, 'u_alice', 'bare', { opKey: 'k-bare' }), 409, 'QUAL_NO_SNAPSHOT');
});

test('review: fixture happy path replays without double rows', async () => {
  const t = await qualEnv();
  await seedNode(t.DB, { id: 'res1', owner: 'u_alice' });
  const first = await postAs(t, 'u_alice', 'res1', { opKey: 'k1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.receipt.mode, 'fixture');
  assert.equal(first.body.advice.benchmarkCatalogId, 'completion-smoke-v1');
  assert.ok(first.body.assignment?.lease_id, 'assignment bound to a lease');
  const again = await postAs(t, 'u_alice', 'res1', { opKey: 'k1' });
  assert.equal(again.body.replay, true);
  const recs = await t.DB.prepare('SELECT COUNT(*) AS n FROM qualification_recommendations').all();
  const runs = await t.DB.prepare('SELECT COUNT(*) AS n FROM qualification_runs').all();
  assert.equal(recs.results[0].n, 1);
  assert.equal(runs.results[0].n, 1);
});

test('review: worker lease binding, stale snapshot, uncertain retention', async () => {
  const t = await qualEnv();
  await seedNode(t.DB, { id: 'res1', owner: 'u_alice' });
  const posted = await postAs(t, 'u_alice', 'res1', { opKey: 'k1' });
  const lease = posted.body.assignment.lease_id;
  const runId = posted.body.assignment.run_id;
  await failsWith(() => handleWorkerNext({ db: t.DB, ownerId: 'u_bob', resourceId: 'res1' }), 404, 'NOT_FOUND');
  const next = await handleWorkerNext({ db: t.DB, ownerId: 'u_alice', resourceId: 'res1' });
  assert.equal(next.status, 200);
  assert.equal(next.body.leaseId, lease);
  const idle = await handleWorkerNext({ db: t.DB, ownerId: 'u_alice', resourceId: 'res1' });
  assert.equal(idle.status, 204);
  await failsWith(
    () => handleWorkerResult({ db: t.DB, ownerId: 'u_alice', resourceId: 'res1', runId, body: goodResult('qlease_wrong') }),
    403, 'QUAL_LEASE_MISMATCH');
  const done = await handleWorkerResult({ db: t.DB, ownerId: 'u_alice', resourceId: 'res1', runId, body: goodResult(lease) });
  assert.deepEqual(done.body, { runId, state: 'succeeded', replay: false });
  const dup = await handleWorkerResult({ db: t.DB, ownerId: 'u_alice', resourceId: 'res1', runId, body: goodResult(lease) });
  assert.equal(dup.body.replay, true);

  // Stale inventory invalidates a pending assignment and retains uncertainty.
  await seedNode(t.DB, { id: 'res2', owner: 'u_alice' });
  const p2 = await postAs(t, 'u_alice', 'res2', { opKey: 'k2' });
  await t.DB.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 64 * 1024 ** 3 }), 'res2').run();
  await failsWith(() => handleWorkerNext({ db: t.DB, ownerId: 'u_alice', resourceId: 'res2' }), 409, 'QUAL_PROFILE_CHANGED');
  await failsWith(
    () => handleWorkerResult({ db: t.DB, ownerId: 'u_alice', resourceId: 'res2', runId: p2.body.assignment.run_id, body: goodResult(p2.body.assignment.lease_id) }),
    409, 'QUAL_UNCERTAIN');
});

test('review: unsupported profile yields honest unsupported, no assignment', async () => {
  const t = await qualEnv();
  await seedNode(t.DB, { id: 'res9', owner: 'u_alice', caps: { runtimes: [], mem: {} } });
  const out = await postAs(t, 'u_alice', 'res9', { opKey: 'k9' });
  assert.equal(out.body.advice.benchmarkCatalogId, 'unsupported');
  assert.equal(out.body.assignment, null);
});

test('review: hostile strings never enter prompt digest; live gate closed', async () => {
  const evil = {
    os: '../../etc/hostname ${EVIL}',
    arch: 'x86_64"; DROP TABLE resources; --',
    runtimes: [{ name: 'ganglion; rm -rf /' }],
    mem: { ramTotalBytes: 8 * 1024 ** 3 },
  };
  const t = await qualEnv();
  await seedNode(t.DB, { id: 'resX', owner: 'u_alice', caps: evil });
  const p = normalizeProfile({
    os: evil.os, arch: evil.arch,
    runtimes_json: JSON.stringify(evil.runtimes),
    mem_json: JSON.stringify(evil.mem),
  });
  assert.equal(p.os, 'unknown');
  assert.equal(p.arch, 'unknown');
  assert.deepEqual(p.runtimes, []);
  const text = digestInput(p, { nodeId: 'resX', mode: 'fixture' });
  for (const leak of ['etc/hostname', 'DROP TABLE', 'rm -rf', 'EVIL']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(text.includes('resX'), 'digest binds the node id');
  const other = digestInput(p, { nodeId: 'resY', mode: 'fixture' });
  assert.notEqual(other, text, 'same hardware on another node digests differently');
  const liveMode = digestInput(p, { nodeId: 'resX', mode: 'live' });
  assert.notEqual(liveMode, text, 'fixture digest never satisfies a live lookup');
  assert.throws(() => digestInput(p, {}), /node id/, 'node id required');
  const out = await postAs(t, 'u_alice', 'resX', { opKey: 'kX' });
  assert.equal(out.body.advice.benchmarkCatalogId, 'unsupported');
  assert.equal(qualificationLiveEnabled({}), false);
  assert.equal(qualificationLiveEnabled({ QUALIFICATION_LIVE: '1' }), false);
  assert.equal(qualificationLiveEnabled({ QUALIFICATION_LIVE: '1', MODEL_API_KEY: 'k' }), true);
  await failsWith(() => preflightLiveRequest(p, [], 0), 402, 'QUAL_SPEND_CAP');
});

test('review: HTTP transport is flag-gated, session-scoped, owner-only', async () => {
  const { readJson } = await import('./d1-shim.mjs');
  const t = await qualEnv({ QUALIFICATION_ENABLED: '1' });
  await seedNode(t.DB, { id: 'res1', owner: 'u_alice' });
  const ok = await readJson(await t.call('/api/resources/res1/qualification', {
    method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { opKey: 'h1' },
  }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.receipt.mode, 'fixture');
  const bobDenied = await readJson(await t.call('/api/resources/res1/qualification', {
    method: 'POST', headers: { ...t.as(t.bob), ...t.csrf }, body: { opKey: 'h2' },
  }));
  assert.equal(bobDenied.status, 404);
  const noSession = await readJson(await t.call('/api/resources/res1/qualification', {
    method: 'POST', headers: { ...t.csrf }, body: { opKey: 'h3' },
  }));
  assert.ok([401, 403].includes(noSession.status), `unauthenticated status ${noSession.status}`);
  const t2 = await qualEnv();
  const off = await readJson(await t2.call('/api/qualifications', { headers: t2.as(t2.alice) }));
  assert.equal(off.status, 404);
});

test('review: same identity replays from cache without spending', async () => {
  const t = await qualEnv();
  await seedNode(t.DB, { id: 'res1', owner: 'u_alice' });
  const first = await postAs(t, 'u_alice', 'res1', { opKey: 'qa' });
  assert.equal(first.status, 200);
  const again = await postAs(t, 'u_alice', 'res1', { opKey: 'qb' });
  assert.equal(again.status, 200);
  assert.equal(again.body.cached, true);
  const recs = await t.DB.prepare('SELECT COUNT(*) AS n FROM qualification_recommendations').all();
  assert.equal(recs.results[0].n, 1);
});

test('review: owner hourly quota enforced on distinct identities', async () => {
  const t = await qualEnv({ QUAL_OWNER_PER_HOUR: 1 });
  await seedNode(t.DB, { id: 'res1', owner: 'u_alice' });
  const ok = await postAs(t, 'u_alice', 'res1', { opKey: 'qa' });
  assert.equal(ok.status, 200);
  await t.DB.prepare('UPDATE node_capabilities SET mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 16 * 1024 ** 3 }), 'res1').run();
  await failsWith(() => postAs(t, 'u_alice', 'res1', { opKey: 'qb' }), 429, 'QUAL_FIXTURE_QUOTA');
});
