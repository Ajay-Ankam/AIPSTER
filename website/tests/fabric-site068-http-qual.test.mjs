// WEB068 HTTP qualification (committed): report -> models -> auto dispatch ->
// worker lease -> result intake -> OpenAI completion, every leg through the
// real worker.js HTTP routes with disposable fixture identities.
// Synthetic completion content only; no network, no models. The Python
// one-shot runner leg (fetch_next/validate/post_result over loopback HTTP)
// is qualified out-of-band; the lease/result shapes posted here are the same
// wire the runner uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, readJson } from './d1-shim.mjs';

const ON = { INFERENCE_ENABLED: '1', INFERENCE_OWNER_DAILY_TOKENS: '8192' };
const S = (t, user) => ({ ...t.as(user), ...t.csrf });
const K = (secret) => ({ Authorization: `Bearer ${secret}` });
const MODEL = 'fixture-qwen068-synth';
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

test('report to completion carries the transported finish reason', async () => {
  const t = await createTestEnv(ON);
  // Register node + heartbeat key + usable heartbeat (real intake routes).
  const reg = await readJson(await t.call('/api/inventory', {
    method: 'POST', headers: S(t, t.alice),
    body: { name: 'qual068-box', kind: 'local', origin: 'lab', cpu: 'x', gpu: 'y' },
  }));
  assert.equal(reg.status, 201, reg.text);
  const nodeId = reg.json.id;
  const hb = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, t.alice),
    body: { name: 'hb', scope: 'heartbeat', resourceId: nodeId },
  }));
  assert.equal(hb.status, 201, hb.text);
  const beat = await t.call(`/api/resources/${nodeId}/heartbeat`, {
    method: 'POST', headers: K(hb.json.secret), body: JSON.stringify({ usable: true }),
  });
  assert.equal(beat.status, 200, await beat.text());

  // Capability report WITH the models extension via the real intake route:
  // the worker.js validator must accept what pairing.py attaches.
  const cap = await readJson(await t.call(`/api/resources/${nodeId}/capabilities`, {
    method: 'POST',
    headers: K(hb.json.secret),
    body: {
      schema_version: 1, os: 'fixture-os', arch: 'fixture-arch',
      runtimes: [{ name: 'llama-server', formats: ['gguf'], models: [MODEL] }],
      mem: { ramTotalBytes: 8 * 1024 ** 3, ramAvailBytes: 4 * 1024 ** 3 },
      disk: { totalBytes: 100 * 1024 ** 3, availBytes: 50 * 1024 ** 3 },
      workload: {},
    },
  }));
  assert.equal(cap.status, 200, cap.text);

  const caller = await readJson(await t.call('/api/keys', {
    method: 'POST', headers: S(t, t.alice), body: { name: 'caller', scope: 'inference' },
  }));
  assert.equal(caller.status, 201, caller.text);

  const models = await readJson(await t.call('/v1/models', {
    method: 'GET', headers: K(caller.json.secret),
  }));
  assert.equal(models.status, 200, models.text);
  assert.ok((models.json.data || []).some((m) => m.id === MODEL), 'fixture model advertised');

  // Fire chat (the route long-polls for a runner), then play the runner side
  // over the same HTTP routes a real worker uses: lease + result intake.
  const chatPromise = t.call('/v1/chat/completions', {
    method: 'POST',
    headers: { ...K(caller.json.secret), 'Idempotency-Key': 'qual068-commit1' },
    body: { model: 'auto', messages: [{ role: 'user', content: 'qual068 says hi' }] },
  });
  await SLEEP(300);
  const lease = await readJson(await t.call('/api/worker/jobs/next', {
    method: 'GET', headers: K(hb.json.secret),
  }));
  assert.equal(lease.status, 200, lease.text);
  const env = lease.json.envelope;
  const posted = await readJson(await t.call(`/api/worker/jobs/${lease.json.job_id}/result`, {
    method: 'POST',
    headers: K(hb.json.secret),
    body: {
      lease_id: lease.json.lease_id,
      status: 'succeeded',
      result: {
        request_id: lease.json.job_id,
        node_id: env.task.placement.node_id,
        runtime_id: env.task.placement.runtime_id,
        model_id: env.task.model_id,
        runtime_instance: env.binding.runtime_instance,
        model_fingerprint: env.binding.model_fingerprint,
        simulated: false,
        content: 'SYNTHETIC fixture completion for WEB068 HTTP qualification; no model was executed.',
        elapsed_ms: 5,
        usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
        cache: {},
        finish_reason: 'stop',
      },
    },
  }));
  assert.equal(posted.status, 200, posted.text);

  const chat = await readJson(await chatPromise);
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.object, 'chat.completion');
  assert.equal(chat.json.model, MODEL);
  assert.equal(chat.json.choices[0].finish_reason, 'stop');
  assert.match(chat.json.choices[0].message.content, /SYNTHETIC fixture completion/);
  assert.equal(chat.json.provenance.path, 'fabric');
  assert.equal(chat.json.provenance.node_id, nodeId);
  assert.equal(chat.json.provenance.runtime_id, 'llama-server');
  assert.equal(chat.json.provenance.simulated, false);
  assert.deepEqual(chat.json.usage, { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 });
});
