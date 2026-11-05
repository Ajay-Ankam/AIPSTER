/* Built with Meta Muse. Meta-qual lane: focused contract tests (no live calls). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkQualificationBody, promptTpsOf, tpsOf, validateAssignment, validateProviderAdvice, validateWorkerResultReport,
} from '../src/qualification/validate.mjs';

const advice = () => ({
  summary: 'CPU smoke looks supportable.',
  suggestions: [{ label: 'completion-smoke-v1', detail: 'Run the fixed smoke.' }],
  rationale: 'Known runtime present.',
  unknowns: ['Measured throughput unknown.'],
  benchmarkCatalogId: 'completion-smoke-v1',
});

test('advice: happy path + unsupported', () => {
  validateProviderAdvice(advice());
  validateProviderAdvice({ ...advice(), suggestions: [], benchmarkCatalogId: 'unsupported' });
});

test('advice: rejects extra keys, bad catalog, oversized', () => {
  assert.throws(() => validateProviderAdvice({ ...advice(), extra: 1 }), /Unknown field/);
  assert.throws(() => validateProviderAdvice({ ...advice(), benchmarkCatalogId: 'gpu-burn-v9' }), /benchmarkCatalogId/);
  assert.throws(() => validateProviderAdvice({ ...advice(), suggestions: [{ label: 'x', detail: 'y', tps: 99 }] }), /Unknown field/);
  assert.throws(() => validateProviderAdvice({ ...advice(), summary: '' }), /summary/);
});

test('owner body: only opKey, strict id', () => {
  assert.deepEqual(checkQualificationBody(undefined), { opKey: null });
  assert.deepEqual(checkQualificationBody({}), { opKey: null });
  assert.deepEqual(checkQualificationBody({ opKey: 'op-1' }), { opKey: 'op-1' });
  assert.throws(() => checkQualificationBody({ opKey: 'has space' }), /opKey/);
  assert.throws(() => checkQualificationBody({ task: 'smuggled' }), /Unknown field/);
});

const assignment = () => ({
  runId: 'qrun_1', nodeId: 'res1', profileDigest: 'a'.repeat(64),
  catalogVersion: 'qual-catalog-v1', catalogId: 'completion-smoke-v1',
  leaseId: 'qlease_1', deadlineAt: new Date(Date.now() + 15000).toISOString(),
  runtimeAllowlist: ['ganglion'], maxTokens: 32,
});

test('assignment: happy path; rejects wrong catalog/tokens', () => {
  validateAssignment(assignment());
  assert.throws(() => validateAssignment({ ...assignment(), catalogId: 'other' }), /catalogId/);
  assert.throws(() => validateAssignment({ ...assignment(), maxTokens: 64 }), /maxTokens/);
  assert.throws(() => validateAssignment({ ...assignment(), profileDigest: 'zz' }), /profileDigest/);
});

const timings = () => ({ promptN: 10, promptMs: 500, predictedN: 32, predictedMs: 1000 });

const report = () => ({
  leaseId: 'qlease_1', status: 'succeeded',
  result: { runtimeId: 'ganglion', modelId: 'm', elapsedMs: 1200, promptTokens: 10, completionTokens: 32, nativeTimings: timings(), finishReason: 'stop' },
});

test('worker result: strict shape, no worker TPS field', () => {
  validateWorkerResultReport(report());
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, tokensPerSecond: 99 } }), /bounded measurements/);
  // Catalog bounds: at most 32 generated tokens, not the old 1024 window.
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, completionTokens: 33 } }), /bounded measurements/);
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, finishReason: 'tool_calls' } }), /bounded measurements/);
  assert.throws(() => validateWorkerResultReport({ leaseId: 'qlease_1', status: 'succeeded' }), /only leaseId/);
  assert.throws(() => validateWorkerResultReport({ ...report(), leaseId: 'bad id!' }), /leaseId/);
  // Native served identity + placement provenance: optional, strictly
  // bounded, and neither certifies hardware placement.
  validateWorkerResultReport({ ...report(), result: { ...report().result, servedModelId: 'm-up', placementProvenance: 'unknown' } });
  validateWorkerResultReport({ ...report(), result: { ...report().result, placementProvenance: 'operator-declared' } });
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, servedModelId: '' } }), /bounded measurements/);
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, servedModelId: 'x'.repeat(257) } }), /bounded measurements/);
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, placementProvenance: 'verifiedCPU' } }), /bounded measurements/);
  assert.throws(() => validateWorkerResultReport({ ...report(), result: { ...report().result, placement: 'cpu' } }), /bounded measurements/);
  for (const status of ['failed', 'timed_out', 'unsupported', 'uncertain']) {
    validateWorkerResultReport({ leaseId: 'qlease_1', status, result: { reason: 'NO_MODEL' } });
  }
  assert.throws(() => validateWorkerResultReport({ leaseId: 'qlease_1', status: 'running', result: {} }), /status/);
});

test('tpsOf: only coherent native pairs', () => {
  assert.equal(tpsOf({}), null);
  assert.equal(tpsOf({ elapsedMs: 1000 }), null);
  // Coherent: 32 predicted in 1000ms -> 32 tps generation, 20 tps prefill.
  const good = { completionTokens: 32, nativeTimings: timings() };
  assert.equal(tpsOf(good), 32);
  assert.equal(promptTpsOf(good), 20);
  // Inconsistent counts (pair disagrees with reported completions) -> null.
  assert.equal(tpsOf({ completionTokens: 31, nativeTimings: timings() }), null);
  // Malformed pairs: bool, NaN, negative, zero duration, over-catalog -> null.
  for (const bad of [
    { ...timings(), predictedN: true }, { ...timings(), predictedMs: NaN },
    { ...timings(), predictedMs: 0 }, { ...timings(), predictedN: 33 },
    { ...timings(), predictedN: 31.5 }, { ...timings(), promptN: -1 },
  ]) {
    assert.equal(tpsOf({ nativeTimings: bad }), null);
  }
  // Wall-clock-only result never yields TPS even with token counts.
  assert.equal(tpsOf({ elapsedMs: 1000, completionTokens: 32 }), null);
});
