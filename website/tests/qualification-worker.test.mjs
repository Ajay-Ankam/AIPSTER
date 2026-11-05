/* Built with Meta Muse. Meta-qual lane: worker route auth tests (fixtures only). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv, readJson } from './d1-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUAL_MIGRATION = readFileSync(path.join(ROOT, 'migrations', '0030_qualification.sql'), 'utf8');

async function qualEnv(envOver = {}) {
  const t = await createTestEnv({ QUALIFICATION_ENABLED: '1', ...envOver });
  t.sqlite.exec(QUAL_MIGRATION);
  const now = new Date().toISOString();
  await t.DB.prepare('INSERT INTO resources (id, owner_id, name, kind, origin, cpu, gpu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('res1', t.alice.id, 'node-1', 'local', 'lab', 'x86', 'none', now).run();
  await t.DB.prepare('INSERT INTO node_capabilities (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .bind('res1', now, 'linux', 'x86_64',
      JSON.stringify([{ name: 'ganglion' }]),
      JSON.stringify({ ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 1 }),
      JSON.stringify({ totalBytes: 100, availBytes: 1 }),
      JSON.stringify({})).run();
  return t;
}

test('qual routes: anonymous gets 401 even when flag is off (no oracle)', async () => {
  const t = await createTestEnv({});
  const r = await readJson(await t.call('/api/qualifications'));
  assert.equal(r.status, 401);
});

test('qual routes: session without flag gets 404', async () => {
  const t = await createTestEnv({});
  const r = await readJson(await t.call('/api/qualifications', { headers: t.as(t.alice) }));
  assert.equal(r.status, 404);
});

test('qual POST: missing CSRF is 403; happy path is 200 fixture', async () => {
  const t = await qualEnv();
  const noCsrf = await readJson(await t.call('/api/resources/res1/qualification', { method: 'POST', headers: t.as(t.alice), body: {} }));
  assert.equal(noCsrf.status, 403);
  const ok = await readJson(await t.call('/api/resources/res1/qualification', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: { opKey: 'op-9' } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.receipt.mode, 'fixture');
  assert.equal(ok.json.advice.benchmarkCatalogId, 'completion-smoke-v1');
});

test('qual GET: owner-only report after POST', async () => {
  const t = await qualEnv();
  await t.call('/api/resources/res1/qualification', { method: 'POST', headers: { ...t.as(t.alice), ...t.csrf }, body: {} });
  const mine = await readJson(await t.call('/api/qualifications', { headers: t.as(t.alice) }));
  assert.equal(mine.status, 200);
  assert.equal(mine.json.recommendations.length, 1);
  const other = await readJson(await t.call('/api/qualifications', { headers: t.as(t.bob) }));
  assert.equal(other.status, 200);
  assert.deepEqual(other.json.recommendations, []);
  assert.deepEqual(other.json.runs, []);
});

test('qual worker routes: sessions cannot use heartbeat endpoints', async () => {
  const t = await qualEnv();
  const r = await readJson(await t.call('/api/worker/qualifications/next', { headers: t.as(t.alice) }));
  assert.equal(r.status, 403);
});
