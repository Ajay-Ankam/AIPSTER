/* Built with Meta Muse. Meta-qual lane: provider transport tests. */
/* Stubbed fetch only proves contracts, never live behavior: no key, no net. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLiveRequest, preflightLiveRequest, runFixture, runLive,
} from '../src/qualification/provider.mjs';
import { QUAL_MODEL } from '../src/qualification/constants.mjs';

const PROFILE = { os: 'linux', arch: 'x86_64', runtimes: [{ name: 'ganglion' }], memTotalBytes: 8 * 1024 ** 3, diskTotalBytes: 100, gpuCount: 0, gpuVramTotalBytes: 0 };

function adviceWire(over = {}) {
  return {
    id: 'resp_1', model: QUAL_MODEL, status: 'completed',
    usage: { input_tokens: 100, output_tokens: 50 },
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(fixtureAdvice()) }] }],
    ...over,
  };
}

function fixtureAdvice() {
  return {
    summary: 'CPU smoke looks supportable.',
    suggestions: [{ label: 'completion-smoke-v1', detail: 'Run it.' }],
    rationale: '', unknowns: [], benchmarkCatalogId: 'completion-smoke-v1',
  };
}

test('provider: live request is bounded with minimal reasoning', () => {
  const { url, body } = buildLiveRequest(PROFILE, ['completion-smoke-v1']);
  assert.equal(url, 'https://api.meta.ai/v1/responses');
  assert.equal(body.model, QUAL_MODEL);
  assert.equal(body.max_output_tokens, 512);
  assert.deepEqual(body.reasoning, { effort: 'minimal' });
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
});

test('provider: preflight reserves byte-bound tokens, gates spend cap', () => {
  const { body } = buildLiveRequest(PROFILE, ['completion-smoke-v1']);
  const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  const pre = preflightLiveRequest(PROFILE, ['completion-smoke-v1'], 10);
  assert.equal(pre.inputTokens, bytes);
  assert.throws(() => preflightLiveRequest(PROFILE, ['completion-smoke-v1'], 0), /spend cap/i);
});

test('provider: fixture never looks live', () => {
  const out = runFixture(PROFILE, ['completion-smoke-v1']);
  assert.equal(out.benchmarkCatalogId, 'completion-smoke-v1');
  const uns = runFixture({ os: 'unknown', arch: 'unknown', runtimes: [], memTotalBytes: 0, diskTotalBytes: 0, gpuCount: 0, gpuVramTotalBytes: 0 }, []);
  assert.equal(uns.benchmarkCatalogId, 'unsupported');
});

async function liveWith(fetchImpl, wire = adviceWire(), deadlineMs = 5000) {
  const seen = {};
  const wrapped = async (url, init) => {
    seen.init = init;
    return fetchImpl(url, init);
  };
  const out = await runLive({ fetchImpl: wrapped, key: 'k', profileFacts: PROFILE, eligibleCatalog: ['completion-smoke-v1'], deadlineMs });
  return { out, seen };
}

test('provider: happy path validates and reports unknown-safe usage', async () => {
  const { out, seen } = await liveWith(async () => new Response(JSON.stringify(adviceWire())));
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(out.model, QUAL_MODEL);
  assert.equal(out.advice.benchmarkCatalogId, 'completion-smoke-v1');
  assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 50 });
});

test('provider: invalid usage stays unknown, spend from byte bound', async () => {
  const wire = adviceWire({ usage: { input_tokens: -5, output_tokens: 'many' } });
  const { out } = await liveWith(async () => new Response(JSON.stringify(wire)));
  assert.deepEqual(out.usage, { inputTokens: null, outputTokens: null });
  assert.ok(out.spendUsdEst > 0);
});

test('provider: redirects and opaque responses are refused, never followed', async () => {
  await assert.rejects(liveWith(async () => new Response(null, { status: 302 })), (e) => e.code === 'PROVIDER_REDIRECT');
  await assert.rejects(liveWith(async () => ({ status: 0 })), (e) => e.code === 'PROVIDER_OPAQUE');
});

test('provider: wrong or missing model echo fails closed', async () => {
  await assert.rejects(liveWith(async () => new Response(JSON.stringify(adviceWire({ model: 'other-model' })))), (e) => e.code === 'PROVIDER_MODEL_MISMATCH');
  const noModel = adviceWire();
  delete noModel.model;
  await assert.rejects(liveWith(async () => new Response(JSON.stringify(noModel))), (e) => e.code === 'PROVIDER_MODEL_MISMATCH');
});

test('provider: incomplete responses fail closed', async () => {
  await assert.rejects(liveWith(async () => new Response(JSON.stringify(adviceWire({ status: 'in_progress' })))), (e) => e.code === 'PROVIDER_INCOMPLETE');
});

test('provider: incomplete diagnostics retain safe reason/usage without output or retry', async () => {
  let calls = 0;
  await assert.rejects(liveWith(async () => {
    calls++;
    return new Response(JSON.stringify(adviceWire({ status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens', secret: 'must-not-leak' },
      output_text: 'must-not-leak',
    })));
  }), (e) => {
    assert.equal(e.code, 'PROVIDER_INCOMPLETE');
    assert.deepEqual(e.providerDiagnostic, { httpStatus: 200, status: 'incomplete', reason: 'max_output_tokens', usage: { inputTokens: 100, outputTokens: 50 } });
    assert.match(e.message, /Output token limit reached/);
    assert.equal(JSON.stringify(e).includes('must-not-leak'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('provider: arbitrary incomplete metadata is discarded', async () => {
  await assert.rejects(liveWith(async () => new Response(JSON.stringify(adviceWire({
    incomplete: true, status: 'secret-status', incomplete_details: { reason: 'secret-reason' },
    usage: { input_tokens: -1, output_tokens: 'secret-tokens' },
  })))), (e) => {
    assert.deepEqual(e.providerDiagnostic, { httpStatus: 200, status: 'unknown', reason: 'unknown', usage: { inputTokens: null, outputTokens: null } });
    assert.equal(JSON.stringify(e).includes('secret-'), false);
    return true;
  });
});

test('provider: oversized bodies are refused', async () => {
  const big = 'x'.repeat(70 * 1024);
  await assert.rejects(liveWith(async () => new Response(JSON.stringify(adviceWire({ output: [{ content: [{ type: 'output_text', text: big }] }] })))), (e) => e.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('provider: stalled streams hit the total deadline even if the stub ignores abort', async () => {
  const hanging = {
    status: 200,
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
  };
  await assert.rejects(liveWith(async () => hanging, adviceWire(), 50), (e) => e.code === 'PROVIDER_TIMEOUT');
});

