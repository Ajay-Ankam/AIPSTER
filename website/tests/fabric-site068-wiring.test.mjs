// WEB068 site wiring: the top-level /v1 entrypoint in website/src/worker.js.
// These tests own the worker.js call site: flag gate, auth parity
// (inference key and session+CSRF), owner-bound inventory, typed
// no-eligible/unknown outcomes — never via direct route/store calls.
// Fixtures are disposable (in-memory D1 shim); no network, no models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

const ON = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const S = (t, user) => ({ ...t.as(user), ...t.csrf });
const K = (secret) => ({ Authorization: `Bearer ${secret}` });
const CHAT = { model: 'auto', messages: [{ role: 'user', content: 'Say hello (fixture)' }] };

async function readyNode(t, user = t.alice, name = 'box') {
  const reg = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: S(t, user), body: { name, kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(reg.status, 201, reg.text);
  const hb = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, user), body: { name: 'hb', scope: 'heartbeat', resourceId: reg.json.id },
  }));
  assert.equal(hb.status, 201, hb.text);
  const beat = await t.call(`/api/resources/${reg.json.id}/heartbeat`, {
    method: 'POST', headers: K(hb.json.secret), body: JSON.stringify({ usable: true }),
  });
  assert.equal(beat.status, 200, await beat.text());
  return { resourceId: reg.json.id };
}

async function inferenceKey(t, user = t.alice) {
  const k = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, user), body: { name: 'caller', scope: 'inference' },
  }));
  assert.equal(k.status, 201, k.text);
  return k.json.secret;
}

async function reportModels(t, resourceId, runtimes, ageMs = 1000) {
  const at = new Date(Date.now() - ageMs).toISOString();
  await t.DB.prepare(`INSERT INTO node_capabilities
    (node_id, schema_version, reported_at, os, arch, runtimes_json, mem_json, disk_json, workload_json)
    VALUES (?, 1, ?, 'fixture-os', 'fixture-arch', ?, '{}', '{}', '{}')`)
    .bind(resourceId, at, JSON.stringify(runtimes)).run();
}

test('disabled flag fails closed as JSON, never ASSETS HTML', async () => {
  const t = await createTestEnv();
  for (const [path, method, body] of [
    ['/v1/models', 'GET', undefined],
    ['/v1/chat/completions', 'POST', CHAT],
    ['/v1/operations/alice-op-00000001', 'GET', undefined],
  ]) {
    const res = await t.call(path, { method, headers: {}, body });
    assert.equal(res.status, 403, path);
    const text = await res.text();
    assert.doesNotMatch(text, /<!doctype html>/i, `${path} must not fall through to assets`);
    assert.equal(JSON.parse(text).code, 'INFERENCE_DISABLED', path);
  }
});

test('enabled routes require auth and reject malformed operation keys', async () => {
  const t = await createTestEnv(ON);
  for (const [path, method, body] of [
    ['/v1/models', 'GET', undefined],
    ['/v1/chat/completions', 'POST', CHAT],
    ['/v1/operations/alice-op-00000001', 'GET', undefined],
  ]) {
    const anon = await readJson(await t.call(path, { method, body }));
    assert.equal(anon.status, 401, path);
    assert.equal(anon.json.code, 'AUTH_REQUIRED', path);
  }
  const bad = await readJson(await t.call('/v1/operations/!!bad', { headers: {} }));
  assert.equal(bad.status, 404);
  assert.equal(bad.json.code, 'UNKNOWN_API_ROUTE', 'unknown key shape is a typed 404, not ASSETS HTML');
  const wrongMethod = await t.call('/v1/models', { method: 'POST', body: {} });
  assert.equal(wrongMethod.status, 404);
  assert.equal((await wrongMethod.json()).code, 'NOT_FOUND', 'wrong method is the generic unknown route');
});

test('no capability evidence means typed no-eligible, never fabricated', async () => {
  const t = await createTestEnv(ON);
  await readyNode(t);
  const secret = await inferenceKey(t);
  const models = await readJson(await t.call('/v1/models', { headers: K(secret) }));
  assert.equal(models.status, 200, models.text);
  assert.deepEqual(models.json.data, [], 'owner-bound inventory is empty, not fabricated');
  const chat = await readJson(await t.call('/v1/chat/completions', {
    method: 'POST', headers: { ...K(secret), 'Idempotency-Key': 'alice-w068-00000001' }, body: CHAT,
  }));
  assert.equal(chat.status, 409, chat.text);
  assert.equal(chat.json.error.code, 'no_eligible_worker', 'typed no-eligible, nothing fabricated');
});

test('fresh evidence advertises the probed model; wrong models and outcomes stay typed', async () => {
  const t = await createTestEnv(ON);
  const { resourceId } = await readyNode(t);
  await reportModels(t, resourceId, [{ name: 'llama-server', models: ['fixture-model-068'], formats: ['openai-chat'] }]);
  const secret = await inferenceKey(t);
  const models = await readJson(await t.call('/v1/models', { headers: K(secret) }));
  assert.equal(models.status, 200, models.text);
  assert.equal(models.json.data.length, 1);
  assert.equal(models.json.data[0].id, 'fixture-model-068');
  const wrong = await readJson(await t.call('/v1/chat/completions', {
    method: 'POST', headers: { ...K(secret), 'Idempotency-Key': 'alice-w068-00000002' },
    body: { ...CHAT, model: 'no-such-model' },
  }));
  assert.equal(wrong.status, 404, wrong.text);
  assert.equal(wrong.json.error.code, 'model_not_found');
  const badKey = await readJson(await t.call('/v1/chat/completions', {
    method: 'POST', headers: { ...K(secret), 'Idempotency-Key': 'x' }, body: CHAT,
  }));
  assert.equal(badKey.status, 400);
  assert.equal(badKey.json.error.code, 'invalid_request', 'malformed keys are refused, never replaced');
  const unknown = await readJson(await t.call('/v1/operations/alice-op-never-issued', { headers: K(secret) }));
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.error.code, 'operation_not_found', 'unknown operations reconcile as not-found');
});

test('sessions pass with CSRF and fail without it', async () => {
  const t = await createTestEnv(ON);
  const { resourceId } = await readyNode(t);
  await reportModels(t, resourceId, [{ name: 'llama-server', models: ['fixture-model-068'] }]);
  const models = await readJson(await t.call('/v1/models', { headers: S(t, t.alice) }));
  assert.equal(models.status, 200, models.text);
  assert.equal(models.json.data[0].id, 'fixture-model-068');
  const noCsrf = await readJson(await t.call('/v1/chat/completions', {
    method: 'POST', headers: t.as(t.alice), body: CHAT,
  }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.code, 'CSRF_REQUIRED');
});
