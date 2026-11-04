import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateChatCompletionRequest, resolveModel, buildDispatchRequest,
  buildModelsList, noEligibleWorker, mapSettledJobToCompletion, mapDispatchResult,
  coerceUsage, OPENAI_DEFAULT_MAX_TOKENS,
} from '../src/inference/fabric-openai.mjs';

const msg = (role, content) => ({ role, content });
const validBody = () => ({ model: 'auto', messages: [msg('user', 'Say ok')], max_tokens: 16 });
const admission = { model_id: 'qwen3-fixture' };
const binding = { node_id: 'node-fixture', runtime_id: 'llama-server', model_id: 'qwen3-fixture',
  runtime_instance: 'instance-fixture', model_fingerprint: 'fingerprint-fixture' };
const expected = { id: 'job-fixture-0001', node_id: binding.node_id,
  runtime_id: binding.runtime_id, model_id: binding.model_id };
const goodJob = (usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, finish = 'stop') => {
  const result = { request_id: expected.id,
    node_id: expected.node_id, runtime_id: expected.runtime_id, model_id: expected.model_id,
    runtime_instance: binding.runtime_instance, model_fingerprint: binding.model_fingerprint,
    simulated: false, content: 'ok', elapsed_ms: 3, usage, cache: {} };
  if (finish !== null) result.finish_reason = finish;
  return { ...expected, status: 'succeeded', result };
};

test('valid single user message validates with bounded defaults (no inference)', () => {
  const out = validateChatCompletionRequest({ messages: [msg('user', 'hi')] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { model: null, content: 'hi', max_tokens: OPENAI_DEFAULT_MAX_TOKENS });
});

test('explicit stream:false is accepted as ordinary non-streaming', () => {
  const out = validateChatCompletionRequest({ ...validBody(), stream: false });
  assert.equal(out.ok, true);
});

test('explicit model is preserved as a server-side constraint', () => {
  const named = validateChatCompletionRequest({ ...validBody(), model: 'qwen3-fixture' });
  assert.equal(named.value.model, 'qwen3-fixture');
});

for (const [field, code, value] of [['stream', 'unsupported_stream', true], ['stream_options', 'unsupported_tools', {}],
  ['tools', 'unsupported_tools', []], ['tool_choice', 'unsupported_tools', 'auto'],
  ['temperature', 'unsupported_parameter', 0.5], ['top_p', 'unsupported_parameter', 1],
  ['mystery', 'unsupported_field', 1]]) {
  test(`refuses ${field} before dispatch (${code})`, () => {
    const out = validateChatCompletionRequest({ ...validBody(), [field]: value });
    assert.equal(out.ok, false);
    assert.equal(out.error.body.error.code, code);
    assert.equal(out.error.http, 400);
  });
}

test('initial route restricts to one user message: multi/role/name refused honestly', () => {
  const multi = validateChatCompletionRequest({ ...validBody(), messages: [msg('user', 'a'), msg('user', 'b')] });
  assert.equal(multi.ok, false);
  assert.equal(multi.error.body.error.code, 'limited_compatibility');
  const system = validateChatCompletionRequest({ ...validBody(), messages: [msg('system', 'Be brief')] });
  assert.equal(system.ok, false);
  assert.equal(system.error.body.error.code, 'limited_compatibility');
  const named = validateChatCompletionRequest({ ...validBody(), messages: [{ role: 'user', content: 'x', name: 'n' }] });
  assert.equal(named.ok, false);
  assert.equal(named.error.body.error.code, 'invalid_message');
});

for (const bad of [{ messages: [] }, { messages: [{ role: 'user', content: ' ' }] },
  { messages: [{ role: 'user', content: 'x'.repeat(65537) }] }, { max_tokens: 0 },
  { max_tokens: 4097 }, { model: '' }, { messages: 'nope' }]) {
  test('rejects malformed request ' + Object.keys(bad)[0], () => {
    assert.equal(validateChatCompletionRequest({ ...validBody(), ...bad }).ok, false);
  });
}

test('model resolution: auto takes admission, mismatch is model_not_found', () => {
  assert.equal(resolveModel(null, admission).value, 'qwen3-fixture');
  assert.equal(resolveModel('qwen3-fixture', admission).value, 'qwen3-fixture');
  const miss = resolveModel('other-model', admission);
  assert.equal(miss.ok, false);
  assert.equal(miss.error.body.error.code, 'model_not_found');
  assert.equal(resolveModel(null, {}).ok, false);
});

test('dispatch request carries coordinator fields only: verbatim prompt, no placement', () => {
  const checked = validateChatCompletionRequest(validBody()).value;
  const req = buildDispatchRequest(checked, { admission_ref: 'admission-0001', idempotency_key: 'operation-0001',
    deadline_at: 1800000001000, model_id: 'qwen3-fixture' });
  assert.deepEqual(Object.keys(req).sort(),
    ['admission_ref', 'contract_version', 'deadline_at', 'idempotency_key', 'max_tokens', 'model_id', 'prompt']);
  assert.equal(req.prompt, 'Say ok');
  assert.ok(!JSON.stringify(req).includes('node-fixture') && !JSON.stringify(req).includes('tenant'));
});

test('dispatch request rejects bad refs and oversized prompts', () => {
  const checked = validateChatCompletionRequest(validBody()).value;
  assert.throws(() => buildDispatchRequest(checked, { admission_ref: 'bad ref!', idempotency_key: 'operation-0001',
    deadline_at: 1, model_id: 'm' }), /INVALID_ADMISSION_REF/);
  const big = { ...checked, content: 'y'.repeat(65537) };
  assert.throws(() => buildDispatchRequest(big, { admission_ref: 'admission-0001',
    idempotency_key: 'operation-0001', deadline_at: 1, model_id: 'm' }), /INVALID_PROMPT/);
});

test('models list advertises only usable+online entries, deduped and sorted', () => {
  const list = buildModelsList([
    { model_id: 'b-model', usable: true, liveness: 'online' },
    { model_id: 'a-model', usable: true, liveness: 'online' },
    { model_id: 'b-model', usable: true, liveness: 'online' },
    { model_id: 'stale-model', usable: true, liveness: 'stale' },
    { model_id: 'down-model', usable: false, liveness: 'online' },
    { model_id: '', usable: true, liveness: 'online' },
  ]);
  assert.deepEqual(list.data.map((m) => m.id), ['a-model', 'b-model']);
  assert.deepEqual(buildModelsList([]), { object: 'list', data: [] });
  const noEligible = noEligibleWorker('a-model');
  assert.equal(noEligible.http, 409);
  assert.equal(noEligible.body.error.code, 'no_eligible_worker');
});

test('usage passes through real counts only; unknown is null, never zero', () => {
  assert.deepEqual(coerceUsage({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
    { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  assert.deepEqual(coerceUsage({ prompt_tokens: 4, completion_tokens: 1 }),
    { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  assert.equal(coerceUsage({}), null);
  assert.equal(coerceUsage({ prompt_tokens: 4 }), null);
  assert.equal(coerceUsage(null), null);
});

test('verified settled job maps to chat.completion with honest finish and usage', () => {
  const mapped = mapSettledJobToCompletion(goodJob(), binding, { created: 1700000000 });
  assert.equal(mapped.ok, true);
  const body = mapped.value;
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'ok');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  assert.deepEqual(body.provenance, { path: 'fabric', job_id: expected.id, node_id: binding.node_id,
    runtime_id: binding.runtime_id, model_id: binding.model_id,
    runtime_instance: binding.runtime_instance, model_fingerprint: binding.model_fingerprint, simulated: false });
  const unknownUsage = mapSettledJobToCompletion(goodJob({}), binding, { created: 1700000000 });
  assert.equal(unknownUsage.value.usage, null);
});

for (const change of [{ node_id: 'wrong-node' }, { model_id: 'wrong-model' }, { simulated: true },
  { content: ' ' }, { runtime_instance: 'wrong-instance' }, { model_fingerprint: 'wrong-fingerprint' },
  { finish_reason: 'tool_calls' }]) {
  test('rejects foreign or malformed result ' + Object.keys(change)[0], () => {
    const job = goodJob(); Object.assign(job.result, change);
    if (change.node_id || change.model_id) job[Object.keys(change)[0]] = Object.values(change)[0];
    const mapped = mapSettledJobToCompletion(job, binding);
    assert.equal(mapped.ok, false);
    assert.equal(mapped.error.body.error.code, 'result_rejected');
  });
}

test('legacy result without finish evidence is refused as unavailable, never invented', () => {
  const mapped = mapSettledJobToCompletion(goodJob(undefined, null), binding);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.error.http, 503);
  assert.equal(mapped.error.body.error.code, 'finish_unavailable');
});

test('settled non-success finishes map to typed errors, never completions', () => {
  const failed = mapDispatchResult({ status: 'settled', op_id: 'op-1', job_id: expected.id,
    outcome: { finish: 'failed' } });
  assert.equal(failed.http, 502);
  assert.equal(failed.body.error.code, 'worker_failed');
  const expired = mapDispatchResult({ status: 'settled', op_id: 'op-1', outcome: { finish: 'expired' } });
  assert.equal(expired.http, 504);
  const withheld = mapDispatchResult({ status: 'settled', op_id: 'op-1', outcome: { finish: 'succeeded', withheld_reason: 'grant_revised' } });
  assert.equal(withheld.http, 503);
  assert.equal(withheld.body.error.code, 'release_withheld');
});

test('settled success with the job row returns 200 chat.completion', () => {
  const out = mapDispatchResult({ status: 'settled', op_id: 'op-1', job_id: expected.id,
    outcome: { finish: 'succeeded', content: 'ok', released: true } }, { job: goodJob(), binding, created: 1700000000 });
  assert.equal(out.http, 200);
  assert.equal(out.body.object, 'chat.completion');
  assert.equal(out.body.provenance.job_id, expected.id);
});

test('interim and terminal dispatch states map honestly', () => {
  const dispatched = mapDispatchResult({ status: 'dispatched', op_id: 'op-1', job_id: expected.id });
  assert.equal(dispatched.http, 202);
  assert.equal(dispatched.body.status, 'dispatched');
  assert.ok(dispatched.body.object !== 'chat.completion');
  assert.equal(mapDispatchResult({ status: 'pending', code: 'OPERATION_IN_PROGRESS' }).http, 409);
  assert.equal(mapDispatchResult({ status: 'released', code: 'NOT_ADMITTED' }).http, 409);
  const cancelled = mapDispatchResult({ status: 'cancelled_before_start', op_id: 'op-1', code: 'CANCELLED' });
  assert.equal(cancelled.http, 200);
  assert.equal(mapDispatchResult({ status: 'expired_before_start', code: 'DEADLINE_EXCEEDED' }).http, 504);
  const refused = mapDispatchResult({ status: 'rejected', code: 'BINDING_MISMATCH', http: 403 });
  assert.equal(refused.http, 403);
  assert.equal(refused.body.error.code, 'binding_mismatch');
});

test('unknown outcomes are retained with holds: 503, no retry, remote not claimed stopped', () => {
  const out = mapDispatchResult({ status: 'uncertain', phase: 'dispatch', code: 'OUTCOME_UNCERTAIN',
    op_id: 'op-1', job_id: expected.id });
  assert.equal(out.http, 503);
  assert.equal(out.body.automatic_retry, false);
  assert.equal(out.body.remote_stopped, false);
  assert.equal(out.body.op_id, 'op-1');
  assert.equal(out.body.job_id, expected.id);
  assert.equal(mapDispatchResult(null).http, 503);
});
