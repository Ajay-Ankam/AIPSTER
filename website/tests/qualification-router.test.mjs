/* Built with Meta Muse. Meta-qual lane: focused router D1 tests (fixtures only). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv } from './d1-shim.mjs';
import { handleQualificationPost, handleQualificationsGet, handleWorkerNext, handleWorkerResult } from '../src/qualification/router.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function qualEnv() {
  const t = await createTestEnv({ QUALIFICATION_ENABLED: '1' });
  t.sqlite.exec(readFileSync(path.join(ROOT, 'migrations', '0030_qualification.sql'), 'utf8'));
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('res1', t.alice.id, 'node-1', 'local', 'lab', 'x86', 'none', now).run();
  await t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind('res1', now, 'linux', 'x86_64',
      JSON.stringify([{ name: 'ganglion', version: '1.2', models: ['m'] }]),
      JSON.stringify({ ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 1024 }),
      JSON.stringify({ totalBytes: 100 * 1024 ** 3, availBytes: 1024 }),
      JSON.stringify({})).run();
  return t;
}

test('model identity: changed models invalidate the assignment at lease', async () => {
  const t = await qualEnv();
  await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  const now = new Date().toISOString();
  await t.DB.prepare('UPDATE node_capabilities SET runtimes_json = ?, reported_at = ? WHERE node_id = ?')
    .bind(JSON.stringify([{ name: 'ganglion', models: ['m', 'm2'] }]), now, 'res1').run();
  await assert.rejects(handleWorkerNext({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1' }), /inventory changed/);
});

test('model identity: snapshot without model evidence cannot succeed', async () => {
  const t = await qualEnv();
  const post = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  const runId = post.body.assignment.run_id;
  const leaseId = post.body.assignment.lease_id;
  await handleWorkerNext({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1' });
  const now = new Date().toISOString();
  await t.DB.prepare('UPDATE node_capabilities SET runtimes_json = ?, reported_at = ? WHERE node_id = ?')
    .bind(JSON.stringify([{ name: 'ganglion' }]), now, 'res1').run();
  // Model evidence vanished: digest changed, so the measurement is stale.
  await assert.rejects(
    handleWorkerResult({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId, body: { leaseId, status: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 5 } } }),
    /inventory changed/,
  );
});

test('model identity: evidence for another model only fails closed unsupported', async () => {
  const t = await qualEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('UPDATE node_capabilities SET runtimes_json = ? WHERE node_id = ?')
    .bind(JSON.stringify([{ name: 'ganglion', models: ['other'] }]), 'res1').run();
  const post = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  const runId = post.body.assignment.run_id;
  const leaseId = post.body.assignment.lease_id;
  await handleWorkerNext({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1' });
  // Evidence present but the reported model is not among it: 403, run stays leased.
  await assert.rejects(
    handleWorkerResult({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId, body: { leaseId, status: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 5 } } }),
    /ready-model evidence/,
  );
  void now;
});

test('model identity: absent evidence fails closed unsupported, never succeeded', async () => {
  const t = await qualEnv();
  await t.DB.prepare('UPDATE node_capabilities SET runtimes_json = ? WHERE node_id = ?')
    .bind(JSON.stringify([{ name: 'ganglion', version: '1.2' }]), 'res1').run();
  const post = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  assert.ok(post.body.assignment, 'runtime present, assignment issued');
  const { run_id: runId, lease_id: leaseId } = post.body.assignment;
  await handleWorkerNext({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1' });
  const done = await handleWorkerResult({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId, body: { leaseId, status: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 5 } } });
  assert.equal(done.body.state, 'unsupported');
});

test('owner POST fixture: persists recommendation + assignment', async () => {
  const t = await qualEnv();
  const out = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: { opKey: 'op-1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.advice.benchmarkCatalogId, 'completion-smoke-v1');
  assert.ok(out.body.assignment);
  assert.equal(out.body.receipt.mode, 'fixture');
  const list = await handleQualificationsGet({ db: t.DB, ownerId: t.alice.id });
  assert.equal(list.body.recommendations.length, 1);
  assert.equal(list.body.runs.length, 1);
});

test('owner POST: replay same key reuses state; cross-owner hidden', async () => {
  const t = await qualEnv();
  await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: { opKey: 'op-1' } });
  const again = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: { opKey: 'op-1' } });
  assert.equal(again.body.replay, true);
  await assert.rejects(
    handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.bob.id, resourceId: 'res1', body: {} }),
    /not yours/,
  );
  const bobList = await handleQualificationsGet({ db: t.DB, ownerId: t.bob.id });
  assert.deepEqual(bobList.body.recommendations, []);
  assert.deepEqual(bobList.body.runs, []);
});

test('owner POST: no snapshot fails closed; no spend confusion', async () => {
  const t = await qualEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('res9', t.alice.id, 'node-9', 'local', 'lab', 'x86', 'none', now).run();
  await assert.rejects(
    handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res9', body: {} }),
    /must report first/,
  );
});

test('worker next/result: lease binding, replay safe, mismatch refused', async () => {
  const t = await qualEnv();
  const post = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  const runId = post.body.assignment.run_id;
  const leaseId = post.body.assignment.lease_id;
  // Unleased runs never accept results, even with the right lease.
  await assert.rejects(
    handleWorkerResult({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId, body: { leaseId, status: 'failed', result: { reason: 'EARLY' } } }),
    /not leased/,
  );
  const next = await handleWorkerNext({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1' });
  assert.equal(next.status, 200);
  assert.equal(next.body.runId, runId);
  assert.ok(Date.parse(next.body.executionDeadline) > Date.now());
  await assert.rejects(
    handleWorkerResult({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId, body: { leaseId: 'qlease_wrong', status: 'failed', result: { reason: 'X' } } }),
    /Lease binding/,
  );
  const done = await handleWorkerResult({
    db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId,
    body: { leaseId, status: 'succeeded', result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 500 } },
  });
  assert.equal(done.body.state, 'succeeded');
  const replay = await handleWorkerResult({
    db: t.DB, ownerId: t.alice.id, resourceId: 'res1', runId,
    body: { leaseId, status: 'failed', result: { reason: 'LATE' } },
  });
  assert.equal(replay.body.replay, true);
  assert.equal(replay.body.state, 'succeeded');
});

test('worker next: changed inventory invalidates assignment', async () => {
  const t = await qualEnv();
  await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  const now = new Date().toISOString();
  await t.DB.prepare('UPDATE node_capabilities SET mem_json = ?, reported_at = ? WHERE node_id = ?')
    .bind(JSON.stringify({ ramTotalBytes: 64 * 1024 ** 3, ramAvailBytes: 1 }), now, 'res1').run();
  await assert.rejects(handleWorkerNext({ db: t.DB, ownerId: t.alice.id, resourceId: 'res1' }), /inventory changed/);
});

test('unsupported profile: fixture advice, no assignment', async () => {
  const t = await qualEnv();
  const now = new Date().toISOString();
  await t.DB.prepare('UPDATE node_capabilities SET runtimes_json = ?, mem_json = ? WHERE node_id = ?')
    .bind(JSON.stringify([]), JSON.stringify({ ramTotalBytes: 0, ramAvailBytes: 0 }), 'res1').run();
  const out = await handleQualificationPost({ db: t.DB, env: t.env, ownerId: t.alice.id, resourceId: 'res1', body: {} });
  assert.equal(out.body.advice.benchmarkCatalogId, 'unsupported');
  assert.equal(out.body.assignment, null);
});
