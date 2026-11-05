/* Built with Meta Muse. */
// DGM bounded local routing experiment: focused tests (offline, no network).
// These execute REAL routing decisions (authoritative scorer + candidate
// mirror) over the fixed synthetic workload. Fixture files are inputs, not
// results: every quality number is measured here at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCandidates } from '../src/routing/policy.mjs';
import { DISABLED_ACTIONS } from '../src/dgm/preview.mjs';
import {
  ROUTING_EVAL_VERSION,
  routingExperimentBoundary,
} from '../src/dgm/routing-experiment.mjs';
import { EVAL_VERSION } from '../../experiments/dgm-routing/contract.mjs';
import { assertBaselinePinned, scoreBaseline, FROZEN_BASELINE_WEIGHTS } from '../../experiments/dgm-routing/baseline.mjs';
import { validateCandidate, isRefusal } from '../../experiments/dgm-routing/candidate-schema.mjs';
import { buildWorkload } from '../../experiments/dgm-routing/workload.mjs';
import { scoreWithWeights, runExperiment, decideOutcome } from '../../experiments/dgm-routing/runner.mjs';
import {
  buildProposalRequest, proposeLiveRouting, acceptInjectedProposal, acceptLiveProposal,
  preflightProposal, buildLivePrompt, classifyRoutingFailure, estimateProposalSpend,
  ROUTING_PROPOSAL_URL,
} from '../../experiments/dgm-routing/meta-adapter.mjs';
import { runLiveExperiment, LIVE_CONSENT } from '../../experiments/dgm-routing/live-run.mjs';
import { CEILING_ACCEPT_TIE, CEILING_SCHEMA, enumerateAllowlist, searchCeiling } from '../../experiments/dgm-routing/ceiling.mjs';
import { assertSplitsIndependent } from '../../experiments/dgm-routing/workload.mjs';
import { buildReport, verifyReport, stableStringify, sha256Hex } from '../../experiments/dgm-routing/report.mjs';
import { buildPromotionArtifact, applyPromotion } from '../../experiments/dgm-routing/promotion.mjs';

const laneRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'experiments', 'dgm-routing');
const readJson = (p) => JSON.parse(readFileSync(join(laneRoot, p), 'utf8'));

test('dgm routing: baseline pinned to route/v1 with frozen weights and scorer source hash', () => {
  const pin = assertBaselinePinned();
  assert.equal(pin.policyVersion, 'route/v1');
  assert.deepEqual(pin.weights, { EXACT_TOKEN: 50, ONLINE: 30, FRESHNESS_MAX: 20, OWNED: 10, HEADROOM: 5 });
  assert.equal(pin.source.file, 'website/src/routing/policy.mjs');
  assert.equal(pin.source.sha256, '13e9eb14bd2bc8d55124ebc493ed7d9373acf154021d2394b8cbef2dab4e6571');
  assert.equal(pin.source.blob, '4c7fecd76a2c26c0170b06169917b223e77dc254');
});

test('dgm routing: candidate mirror equals authoritative scorer at frozen weights', () => {
  const wl = buildWorkload();
  for (const item of [...wl.train.slice(0, 6), ...wl.heldout.slice(0, 6)]) {
    const a = scoreCandidates(item.descriptors, item.features);
    const b = scoreWithWeights(item.descriptors, item.features, { ...FROZEN_BASELINE_WEIGHTS });
    assert.deepEqual(b.ranked.map((r) => [r.alias, r.score]), a.ranked.map((r) => [r.alias, r.score]));
  }
});

test('dgm routing: mirror fidelity covers edges, boundaries, and score ties', () => {
  const desc = (alias, over) => ({
    alias, resourceId: `edge-${alias}`, ownerId: 'o', kind: 'cpu', modelCompat: 'unverified',
    exactTokenMatch: false, caps: ['other'], liveness: 'online', lastSeenAgeMs: 0,
    usable: true, capacity: null, via: { owned: true }, provenance: {},
    ...over,
  });
  const descriptors = [
    // Exact-token + headroom lower boundary (1024 == 2*512): 50+30+20+0+5 = 105.
    desc('r0', { exactTokenMatch: true, caps: ['llama'], lastSeenAgeMs: 59999, capacity: { jobsRemaining: 1, tokensRemaining: 1024 }, via: { grantId: 'g' } }),
    // Identical score to r0: alias tie-break decides (r0 < r1).
    desc('r1', { exactTokenMatch: true, caps: ['llama'], lastSeenAgeMs: 59999, capacity: { jobsRemaining: 1, tokensRemaining: 1024 }, via: { grantId: 'g' } }),
    // Stale, unknown age/capacity, owner-direct: 0+0+0+10+0 = 10.
    desc('r2', { liveness: 'stale', lastSeenAgeMs: null }),
    // Freshness decay boundary (60000ms -> 19), owner-direct, headroom miss by one: 50+30+19+10+0 = 109.
    desc('r10', { exactTokenMatch: true, caps: ['llama'], lastSeenAgeMs: 60000, capacity: { jobsRemaining: 1, tokensRemaining: 1023 } }),
  ];
  const features = { model: 'llama', maxTokens: 512 };
  const a = scoreCandidates(descriptors, features);
  const b = scoreWithWeights(descriptors, features, { ...FROZEN_BASELINE_WEIGHTS });
  assert.deepEqual(a.ranked.map((r) => [r.alias, r.score]), [['r10', 109], ['r0', 105], ['r1', 105], ['r2', 10]]);
  assert.deepEqual(b.ranked.map((r) => [r.alias, r.score]), a.ranked.map((r) => [r.alias, r.score]));
  // Null maxTokens kills headroom everywhere, identically.
  const c = scoreCandidates(descriptors, { model: 'llama', maxTokens: null });
  const d = scoreWithWeights(descriptors, { model: 'llama', maxTokens: null }, { ...FROZEN_BASELINE_WEIGHTS });
  assert.deepEqual(d.ranked.map((r) => [r.alias, r.score]), c.ranked.map((r) => [r.alias, r.score]));
});

test('dgm routing: experiment executes and measures (not fixture scores)', () => {
  const wl = buildWorkload();
  const exp = runExperiment({ candidate: readJson('fixtures/valid-candidate.json'), workload: wl });
  assert.equal(exp.refused, false);
  assert.equal(exp.evalVersion, 'dgm-routing-eval/v1');
  for (const side of [exp.baseline, exp.candidate]) {
    for (const split of [side.train, side.heldout]) {
      assert.ok(Number.isSafeInteger(split.top1Hits) && split.top1Hits >= 0 && split.top1Hits <= split.n);
      assert.ok(split.top1Rate >= 0 && split.top1Rate <= 1);
    }
  }
  assert.ok(exp.guardrails.every((g) => g.passed));
  assert.deepEqual(exp.candidate.weights, { EXACT_TOKEN: 60, ONLINE: 30, FRESHNESS_MAX: 20, OWNED: 10, HEADROOM: 5 });
  assert.equal(exp.candidate.hash, sha256Hex(stableStringify(exp.candidate.weights)));
});

test('dgm routing: invalid and no-delta candidates are refused', () => {
  const bad = validateCandidate(readJson('fixtures/invalid-candidate.json'));
  assert.ok(isRefusal(bad) && bad.reason === 'DGM_CANDIDATE_BAD_WEIGHTS');
  const same = validateCandidate({ weights: { ...FROZEN_BASELINE_WEIGHTS } });
  assert.ok(isRefusal(same) && same.reason === 'DGM_CANDIDATE_NO_DELTA');
  const exp = runExperiment({ candidate: readJson('fixtures/invalid-candidate.json'), workload: buildWorkload() });
  assert.equal(exp.refused, true);
});

test('dgm routing: proposal budget allows at most one per experiment', () => {
  const wl = buildWorkload();
  const cand = readJson('fixtures/valid-candidate.json');
  assert.throws(() => runExperiment({ candidate: cand, workload: wl, proposalsUsed: 2 }), /at most one proposal/);
});

test('dgm routing: injected offline response yields candidate with explicit provenance', () => {
  const injected = readJson('fixtures/injected-response.json');
  const acc = acceptInjectedProposal(injected);
  assert.equal(acc.refused, false);
  assert.deepEqual(acc.candidate.weights, { EXACT_TOKEN: 60, ONLINE: 30, FRESHNESS_MAX: 20, OWNED: 10, HEADROOM: 5 });
  assert.equal(acc.provenance.evaluation, 'injected-offline');
  // Injected model labels are caller-supplied, never observed: always unverified.
  assert.equal(acc.provenance.model, 'muse-spark-1.3-contributor');
  assert.equal(acc.provenance.modelVerified, false);
  const noFence = acceptInjectedProposal({ text: 'no json here' });
  assert.ok(noFence.refused === true);
  const req = buildProposalRequest('rank these test fabrics');
  assert.equal(req.body.max_output_tokens, 512);
  assert.equal(req.body.model, 'muse-spark-1.3-contributor');
});

test('dgm routing: live proposal refuses without key, budget, or consent (no call sent)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not be called'); };
  await assert.rejects(
    proposeLiveRouting({ fetchImpl, prompt: 'x' }), /server-side caller key required/);
  await assert.rejects(
    proposeLiveRouting({ fetchImpl, apiKey: 'k', prompt: 'x' }), /spend budget is required/);
  await assert.rejects(
    runLiveExperiment({ fetchImpl, apiKey: 'k', consent: 'nope', maxSpendUsd: 1 }), /explicit consent/);
  await assert.rejects(
    runLiveExperiment({ fetchImpl, apiKey: '', consent: LIVE_CONSENT, maxSpendUsd: 1 }), /caller key/);
  assert.equal(calls, 0);
});

const strictCandidate = (weights) => JSON.stringify({ weights });
const VALID_W = { EXACT_TOKEN: 60, ONLINE: 30, FRESHNESS_MAX: 20, OWNED: 10, HEADROOM: 5 };

function wireResponse({ text, model = 'muse-spark-1.3-contributor', id = 'resp_test_1', usage = { input_tokens: 100, output_tokens: 50 } } = {}) {
  return {
    status: 200,
    body: null,
    text: async () => JSON.stringify({
      id, model, usage,
      output: [{ content: [{ type: 'output_text', text }] }],
    }),
  };
}

test('dgm routing: live proposal succeeds over injected fetch with pinned contract', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return wireResponse({ text: strictCandidate(VALID_W) });
  };
  const res = await proposeLiveRouting({ fetchImpl, apiKey: 'SENTINEL-KEY', prompt: 'rank test', maxSpendUsd: 5 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, ROUTING_PROPOSAL_URL);
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(seen[0].opts.redirect, 'manual');
  assert.match(seen[0].opts.headers.Authorization, /^Bearer SENTINEL-KEY$/);
  const body = JSON.parse(seen[0].opts.body);
  // Exact wire shape: pinned model, minimal reasoning, 512 output, no store.
  assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'max_output_tokens', 'model', 'reasoning', 'store']);
  assert.equal(body.model, 'muse-spark-1.3-contributor');
  assert.deepEqual(body.reasoning, { effort: 'minimal' });
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.store, false);
  assert.equal(typeof body.input, 'string');
  assert.equal(res.model, 'muse-spark-1.3-contributor');
  assert.equal(res.responseId, 'resp_test_1');
  assert.deepEqual(res.usage, { input_tokens: 100, output_tokens: 50 });
  assert.deepEqual(JSON.parse(res.proposal), { weights: VALID_W });
  const acc = acceptLiveProposal(res);
  assert.equal(acc.refused, false);
  assert.deepEqual(acc.candidate.weights, VALID_W);
  assert.equal(acc.provenance.evaluation, 'live');
  assert.equal(acc.provenance.modelVerified, true);
});

test('dgm routing: live failures carry sanitized accepted/unknown accounting', async () => {
  const fails = [];
  const run = async (name, response, key = 'k') => {
    const fetchImpl = async () => response;
    try {
      await proposeLiveRouting({ fetchImpl, apiKey: key, prompt: 'x', maxSpendUsd: 5 });
      fails.push(`${name}: NO THROW`);
    } catch (e) {
      fails.push(`${name}: ${e.code} accepted=${e.accepted === true} contact=${classifyRoutingFailure(e).providerContact}/${classifyRoutingFailure(e).acceptance}/${classifyRoutingFailure(e).billing}`);
    }
  };
  await run('redirect', { status: 301, body: null, text: async () => '' });
  await run('rate-limited', { status: 429, body: null, text: async () => '' });
  await run('auth', { status: 401, body: null, text: async () => '' });
  await run('server-error', { status: 500, body: null, text: async () => '' });
  await run('wrong-model', wireResponse({ text: strictCandidate(VALID_W), model: 'some-other-model' }));
  await run('malformed', { status: 200, body: null, text: async () => 'not json' });
  await run('empty-text', { status: 200, body: null, text: async () => '' });
  assert.deepEqual(fails, [
    'redirect: DGM_ROUTING_REDIRECT_REFUSED accepted=true contact=sent/unknown/unknown',
    'rate-limited: DGM_ROUTING_RATE_LIMITED accepted=false contact=sent/not-accepted/not-chargeable',
    'auth: DGM_ROUTING_AUTH accepted=false contact=sent/not-accepted/not-chargeable',
    'server-error: DGM_ROUTING_UPSTREAM accepted=true contact=sent/unknown/unknown',
    'wrong-model: DGM_ROUTING_WRONG_MODEL accepted=true contact=sent/accepted/possibly-chargeable',
    'malformed: DGM_ROUTING_MALFORMED accepted=true contact=sent/accepted/possibly-chargeable',
    'empty-text: DGM_ROUTING_MALFORMED accepted=true contact=sent/accepted/possibly-chargeable',
  ]);
});

test('dgm routing: timeout maps to unknown acceptance (never silent success)', async () => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  const fetchImpl = async () => { throw err; };
  try {
    await proposeLiveRouting({ fetchImpl, apiKey: 'k', prompt: 'x', maxSpendUsd: 5 });
    assert.fail('must throw');
  } catch (e) {
    assert.equal(e.code, 'DGM_ROUTING_TIMEOUT');
    assert.deepEqual(classifyRoutingFailure(e), { providerContact: 'unknown', acceptance: 'unknown', billing: 'unknown' });
  }
});

test('dgm routing: over-budget preflight sends no call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not be called'); };
  const est = estimateProposalSpend('x');
  assert.ok(est.worstCaseSpendUsd > 0 && est.requestBytes > 0);
  await assert.rejects(
    proposeLiveRouting({ fetchImpl, apiKey: 'k', prompt: 'x', maxSpendUsd: est.worstCaseSpendUsd / 2 }),
    /exceeds budget/);
  assert.equal(calls, 0);
  assert.throws(() => preflightProposal('x', 0), /spend budget is required/);
});

test('dgm routing: credential hygiene — adapter never reads files, env, or hc.txt', () => {
  const src = [
    readFileSync(new URL('../../experiments/dgm-routing/meta-adapter.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../../experiments/dgm-routing/live-run.mjs', import.meta.url), 'utf8'),
  ].join('\n');
  assert.ok(!src.includes('hc.txt'), 'no credential filename');
  assert.ok(!src.includes('node:fs'), 'no filesystem access');
  assert.ok(!src.includes('process.env'), 'no environment reads in adapter');
  assert.ok(src.includes('redirect'), 'redirect refusal present');
});

test('dgm routing: fixture archives without improvement (tie or regression, never eligible)', () => {
  const wl = buildWorkload();
  const exp = runExperiment({ candidate: readJson('fixtures/valid-candidate.json'), workload: wl });
  assert.ok(exp.outcome === 'tie-archived' || exp.outcome === 'regression', `outcome is ${exp.outcome}`);
  assert.equal(exp.promotionEligible, false);
  assert.match(exp.outcomeDetail, /synthetic held-out/);
  assert.ok(!exp.outcomeDetail.includes('real-fabric') || exp.outcomeDetail.includes('not a real-fabric claim'));
  assert.ok(exp.guardrails.some((g) => g.name === 'split_independence' && g.passed));
  assert.ok(typeof exp.baseline.source?.sha256 === 'string' && exp.baseline.source.sha256.length === 64);
});

test('dgm routing: outcome rule needs strict gain with zero rank regressions anywhere', () => {
  const base = { top1Hits: 2, meanRankOfOracleBest: 1.5, itemRanks: [1, 1, 3] };
  const gain = { top1Hits: 3, meanRankOfOracleBest: 1.2, itemRanks: [1, 1, 1] };
  assert.deepEqual(decideOutcome(base, gain).outcome, 'improvement');
  assert.equal(decideOutcome(base, gain).eligible, true);
  // Same total but one item swapped = regression, not a tie.
  const swap = { top1Hits: 2, meanRankOfOracleBest: 1.5, itemRanks: [1, 2, 1] };
  assert.deepEqual(decideOutcome(base, swap).outcome, 'regression');
  // Equal totals, no rank worsened anywhere = archived tie.
  const tie = { top1Hits: 2, meanRankOfOracleBest: 1.4, itemRanks: [1, 1, 3] };
  assert.deepEqual(decideOutcome(base, tie).outcome, 'tie-archived');
  // Gain with a worsened item = regression despite higher total.
  const dirty = { top1Hits: 3, meanRankOfOracleBest: 1.2, itemRanks: [2, 1, 1] };
  assert.deepEqual(decideOutcome(base, dirty).outcome, 'regression');
  // Higher total but a deep rank worsened elsewhere (2->3) = regression:
  // the old top1-only rule would have called this an improvement.
  const deep = { top1Hits: 3, meanRankOfOracleBest: 2.0, itemRanks: [1, 1, 3] };
  const deepBase = { top1Hits: 2, meanRankOfOracleBest: 2.0, itemRanks: [1, 1, 2] };
  assert.deepEqual(decideOutcome(deepBase, deep).outcome, 'regression');
});

test('dgm routing: held-out split repeats no train patterns', () => {
  const wl = buildWorkload();
  const ind = assertSplitsIndependent(wl);
  assert.deepEqual(ind, { disjoint: true, crossDuplicates: 0, idCollisions: 0 });
});

test('dgm routing: live end-to-end over injected fetch keeps the key out of outputs', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const storeDir = mkdtempSync(join(tmpdir(), 'dgm-live-'));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return wireResponse({ text: strictCandidate(VALID_W), id: 'resp_live_9' }); };
  const args = { fetchImpl, apiKey: 'SENTINEL-LIVE-KEY-9', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir, ceilingOverride: CEILING_ACCEPT_TIE };
  const out = await runLiveExperiment(args);
  assert.equal(out.replayed, false);
  assert.equal(calls, 1);
  assert.equal(out.experiment.proposalsUsed, 1);
  assert.equal(out.report.proposalProvenance.evaluation, 'live');
  assert.equal(out.report.proposalProvenance.responseId, 'resp_live_9');
  assert.equal(out.receipt.state, 'succeeded');
  assert.deepEqual(out.receipt.spend.aggregate, 'none — per-call budget only in this slice');
  const dumped = JSON.stringify({ report: out.report, promotion: out.promotion, receipt: out.receipt });
  assert.ok(!dumped.includes('SENTINEL-LIVE-KEY-9'), 'key material in outputs');
  assert.ok(verifyReport(out.report, out.digest));
  // Rerun with an unchanged request replays the receipt and never spends again.
  const again = await runLiveExperiment(args);
  assert.equal(again.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(again.receipt, out.receipt);
});

test('dgm routing: stalled 2xx stream is cancelled by the total deadline (accepted, unknown)', async () => {
  const fetchImpl = async () => ({
    status: 200,
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
    text: async () => { throw new Error('no text fallback on streams'); },
  });
  try {
    await proposeLiveRouting({ fetchImpl, apiKey: 'k', prompt: 'x', maxSpendUsd: 5, deadlineMs: 40 });
    assert.fail('must throw');
  } catch (e) {
    assert.equal(e.code, 'DGM_ROUTING_TIMEOUT');
    assert.equal(e.accepted, true);
    assert.equal(e.httpStatus, 200);
    assert.deepEqual(classifyRoutingFailure(e), { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' });
  }
});

test('dgm routing: invalid candidate after provider success keeps receipt and accepted accounting', async () => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const storeDir = mkdtempSync(join(tmpdir(), 'dgm-live-bad-'));
  const fetchImpl = async () => wireResponse({ text: JSON.stringify({ weights: { EXACT_TOKEN: 999 } }), id: 'resp_bad_1' });
  try {
    await runLiveExperiment({ fetchImpl, apiKey: 'SENTINEL-BAD-KEY', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir, ceilingOverride: CEILING_ACCEPT_TIE });
    assert.fail('must throw');
  } catch (e) {
    assert.match(e.code, /DGM_CANDIDATE_BAD_WEIGHTS|DGM_PROPOSAL/);
    assert.ok(e.receipt, 'receipt retained');
    assert.equal(e.receipt.state, 'invalid-candidate');
    assert.deepEqual(e.receipt.provider.usage, { input_tokens: 100, output_tokens: 50 });
    assert.equal(e.receipt.provider.responseId, 'resp_bad_1');
    assert.deepEqual(e.receipt.failure.accounting, { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' });
  }
  const files = readdirSync(storeDir).join('\n');
  assert.ok(!files.includes('SENTINEL-BAD-KEY'));
  for (const f of readdirSync(storeDir)) {
    assert.ok(!readFileSync(join(storeDir, f), 'utf8').includes('SENTINEL-BAD-KEY'), `${f} leaks key`);
  }
});

test('dgm routing: missing observed model is null and unverified, never the pinned model', () => {
  const byLive = acceptLiveProposal({ proposal: strictCandidate(VALID_W), responseId: 'r', usage: null, model: null });
  assert.equal(byLive.refused, false);
  assert.equal(byLive.provenance.model, null);
  assert.equal(byLive.provenance.modelVerified, false);
  const byInjected = acceptInjectedProposal({ text: strictCandidate(VALID_W) });
  assert.equal(byInjected.refused, false);
  assert.equal(byInjected.provenance.model, null);
  assert.equal(byInjected.provenance.modelVerified, false);
});

test('dgm routing: live verifies only the exact pinned model echo', () => {
  const exact = acceptLiveProposal({ proposal: strictCandidate(VALID_W), responseId: 'r', usage: null, model: 'muse-spark-1.3-contributor' });
  assert.equal(exact.provenance.modelVerified, true);
  const other = acceptLiveProposal({ proposal: strictCandidate(VALID_W), responseId: 'r', usage: null, model: 'some-other-model' });
  assert.equal(other.refused, false);
  assert.equal(other.provenance.model, 'some-other-model');
  assert.equal(other.provenance.modelVerified, false);
});

test('dgm routing: post-provider evaluator failure persists uncertain receipt with usage', async () => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const storeDir = mkdtempSync(join(tmpdir(), 'dgm-live-evalfail-'));
  // Provider succeeds; the evaluator then refuses (malformed workload).
  const fetchImpl = async () => wireResponse({ text: strictCandidate(VALID_W), id: 'resp_evalfail_1' });
  try {
    await runLiveExperiment({
      fetchImpl, apiKey: 'SENTINEL-EVALFAIL', consent: LIVE_CONSENT, maxSpendUsd: 5,
      storeDir, workload: { train: [], heldout: null }, ceilingOverride: CEILING_ACCEPT_TIE,
    });
    assert.fail('must throw');
  } catch (e) {
    assert.ok(e.receipt, 'receipt retained');
    assert.equal(e.receipt.state, 'uncertain');
    assert.deepEqual(e.receipt.provider.usage, { input_tokens: 100, output_tokens: 50 });
    assert.equal(e.receipt.provider.responseId, 'resp_evalfail_1');
    assert.deepEqual(e.receipt.failure.accounting, { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' });
  }
  for (const f of readdirSync(storeDir)) {
    assert.ok(!readFileSync(join(storeDir, f), 'utf8').includes('SENTINEL-EVALFAIL'), `${f} leaks key`);
  }
});

test('dgm routing: default attempt store lives under the ignored artifacts tree', async () => {
  const { defaultStoreDir, artifactsDir } = await import('../../experiments/dgm-routing/paths.mjs');
  const { join, sep } = await import('node:path');
  assert.equal(artifactsDir('/root'), join('/root', 'artifacts'));
  const store = defaultStoreDir('/root');
  assert.ok(store.includes(`artifacts${sep}attempts`), `store is ${store}`);
});

test('dgm routing: live prompt is fixed, bounded, strict JSON, and workload-free', () => {
  const prompt = buildLivePrompt();
  assert.ok(prompt.length > 0 && new TextEncoder().encode(prompt).length <= 8 * 1024);
  assert.ok(prompt.includes('EXACT_TOKEN') && prompt.includes('{"weights":{...}}'));
  assert.ok(!prompt.includes('```'), 'no fenced contract anymore');
  for (const term of ['heldout', 'held-out', 'train', 'oracle']) {
    assert.ok(!prompt.toLowerCase().includes(term), `synthetic prompt only: no ${term}`);
  }
});

test('dgm routing: report digest verifies and tampering fails', () => {
  const wl = buildWorkload();
  const exp = runExperiment({ candidate: readJson('fixtures/valid-candidate.json'), workload: wl });
  const { report, digest } = buildReport({ experiment: exp, workloadVersion: 'dgm-routing-workload/v1', workloadSeed: 20261105, sourceSha: 'test' });
  assert.equal(digest.length, 64);
  assert.ok(verifyReport(report, digest));
  assert.ok(!verifyReport({ ...report, promotionEligible: !report.promotionEligible }, digest));
  // Explicit claim boundary travels inside every report.
  assert.match(report.scopeNote, /proposed synthetic proxy/);
  assert.match(report.scopeNote, /regression split, not secret/);
  assert.match(report.scopeNote, /no sealed final audit/);
});

function boundArtifact() {
  const wl = buildWorkload();
  const exp = runExperiment({ candidate: readJson('fixtures/valid-candidate.json'), workload: wl });
  const { report, digest } = buildReport({ experiment: exp, workloadVersion: 'dgm-routing-workload/v1', workloadSeed: 20261105, sourceSha: 'test' });
  const art = buildPromotionArtifact({
    candidateWeights: { ...exp.candidate.weights },
    report,
    reportDigest: digest,
    baseline: { policyVersion: report.baseline.policyVersion, sourceHash: report.baseline.source.sha256 },
    sourceSha: 'test',
  });
  return { exp, report, digest, art };
}

test('dgm routing: promotion artifact binds verified report, weights, and baseline', () => {
  const { art, digest, exp } = boundArtifact();
  assert.equal(art.approved, false);
  assert.equal(art.scope, 'local-only');
  assert.equal(art.eligible, exp.promotionEligible);
  assert.equal(art.outcome, exp.outcome);
  assert.equal(art.reportDigest, digest);
  assert.ok(typeof art.candidateHash === 'string' && art.candidateHash.length === 64);
  // Tampered weights refuse: the binding is verified, not trusted.
  assert.throws(() => buildPromotionArtifact({
    candidateWeights: { ...exp.candidate.weights, ONLINE: 20 },
    report: boundArtifact().report, reportDigest: digest,
    baseline: { policyVersion: 'route/v1', sourceHash: 'x' },
  }), (e) => e.code === 'DGM_PROMOTION_UNBOUND');
  // Tampered report refuses: the digest must recompute.
  const tampered = { ...boundArtifact().report, promotionEligible: true };
  assert.throws(() => buildPromotionArtifact({
    candidateWeights: { ...exp.candidate.weights },
    report: tampered, reportDigest: digest,
    baseline: { policyVersion: 'route/v1', sourceHash: tampered.baseline.source.sha256 },
  }), (e) => e.code === 'DGM_PROMOTION_UNBOUND');
});

test('dgm routing: applyPromotion refuses without approval, report, or recompute inputs', () => {
  const { art } = boundArtifact();
  assert.equal(art.eligible, false);
  assert.throws(() => applyPromotion(art), /human approval required/);
  assert.throws(() => applyPromotion(art, { humanApproved: true }), /bound actual report/);
});

test('dgm routing: crafted caller workload cannot bypass the gate (reviewer repro)', () => {
  // Reviewer repro: real tie artifact, then apply with a crafted 1-item
  // workload where oracleBest favours the candidate. Must refuse the caller
  // workload before any recompute — never reach `prepared`.
  const tied = boundArtifact();
  const crafted = {
    train: [{
      id: 'craft-t0',
      features: { model: 'llama', maxTokens: 512 },
      descriptors: [
        { alias: 'a', resourceId: 'craft-t0-a', ownerId: 'o', kind: 'cpu', modelCompat: 'unverified', exactTokenMatch: true, caps: ['llama'], liveness: 'online', lastSeenAgeMs: 0, usable: true, capacity: null, via: { owned: true }, provenance: {} },
        { alias: 'b', resourceId: 'craft-t0-b', ownerId: 'o', kind: 'cpu', modelCompat: 'unverified', exactTokenMatch: false, caps: ['other'], liveness: 'stale', lastSeenAgeMs: null, usable: true, capacity: null, via: { owned: true }, provenance: {} },
      ],
      oracleBest: 'a',
    }],
    heldout: [],
  };
  const written = [];
  assert.throws(() => applyPromotion(tied.art, {
    humanApproved: true, workload: crafted, report: tied.report, reportDigest: tied.digest,
    writeConfig: (c) => written.push(c),
  }), (e) => e.code === 'DGM_PROMOTION_WORKLOAD_REJECTED');
  assert.equal(written.length, 0, 'no config write on refused apply');
});

test('dgm routing: hand-flipped eligible on a tie artifact fails the canonical recompute', () => {
  // Weights hash intact, flag flipped: only the canonical recompute catches it.
  const tied = boundArtifact();
  const flipped = { ...tied.art, eligible: true };
  assert.throws(() => applyPromotion(flipped, { humanApproved: true, report: tied.report, reportDigest: tied.digest }),
    (e) => e.code === 'DGM_PROMOTION_INELIGIBLE');
});

test('dgm routing: digest mismatch and non-canonical workload reports refuse', () => {
  const tied = boundArtifact();
  // Valid digest of a DIFFERENT report: must not satisfy the artifact binding.
  const other = { ...tied.report, generatedAt: '2000-01-01T00:00:00.000Z' };
  const otherDigest = sha256Hex(stableStringify(other));
  assert.throws(() => applyPromotion(tied.art, { humanApproved: true, report: other, reportDigest: otherDigest }),
    (e) => e.code === 'DGM_PROMOTION_UNBOUND');
  // Re-signed report with a non-canonical workload identity.
  const foreign = { ...tied.report, workload: { version: 'other/v9', seed: 1 } };
  const foreignDigest = sha256Hex(stableStringify(foreign));
  assert.throws(() => applyPromotion(tied.art, { humanApproved: true, report: foreign, reportDigest: foreignDigest }),
    (e) => e.code === 'DGM_PROMOTION_WRONG_WORKLOAD');
  // Tampered weights refuse even with approval.
  const evil = { ...tied.art, candidateWeights: { ...tied.art.candidateWeights, ONLINE: 20 } };
  assert.throws(() => applyPromotion(evil, { humanApproved: true, report: tied.report, reportDigest: tied.digest }),
    /tampered artifact/);
});

test('dgm routing: website execute/promote stay fail-closed (501, no enabler)', () => {
  assert.match(DISABLED_ACTIONS.execute, /disabled/);
  assert.match(DISABLED_ACTIONS.promote, /disabled/);
  assert.deepEqual(routingExperimentBoundary(), {
    schema: 'aipster.dgm.routing-experiment/v1',
    evalVersion: 'dgm-routing-eval/v1',
    baselinePolicy: 'route/v1',
    evaluation: 'local-synthetic',
    websiteExecute: 'refused-501',
    websitePromote: 'refused-501',
    productionAutoPromote: 'never',
  });
  assert.equal(ROUTING_EVAL_VERSION, EVAL_VERSION);
  assert.ok(scoreBaseline !== undefined);
});

// --- Search-space ceiling (exhaustive offline enumeration before any spend) ---

function craftedDescriptor(alias, { exact, liveness, ageMs, owned, tokens }) {
  return {
    alias, resourceId: `crafted-${alias}`, ownerId: 'owner-0', kind: 'cpu', modelCompat: 'unverified',
    exactTokenMatch: exact, caps: exact ? ['llama'] : ['other'], liveness, lastSeenAgeMs: ageMs,
    usable: true, capacity: owned ? null : { jobsRemaining: 3, tokensRemaining: tokens },
    via: owned ? { owned: true } : { grantId: `grant-${alias}` },
    provenance: { policyVersion: 'route/v1', evaluatedAt: 'synthetic' },
  };
}

// One held-out item the baseline misses and EXACT_TOKEN=60/ONLINE=20 fixes:
// r0 exact+stale+granted (oracle-best), r1 online+fresh+owned (baseline top-1).
function reachableWorkload() {
  const wl = buildWorkload();
  const descriptors = [
    craftedDescriptor('r0', { exact: true, liveness: 'stale', ageMs: null, owned: false, tokens: 4096 }),
    craftedDescriptor('r1', { exact: false, liveness: 'online', ageMs: 0, owned: true, tokens: null }),
  ];
  return { ...wl, heldout: [{ id: 'heldout-crafted-0', features: { model: 'llama', maxTokens: 128 }, descriptors, oracleBest: 'r0' }] };
}

test('dgm routing ceiling: enumeration covers the whole allowlist exactly once', () => {
  const space = enumerateAllowlist();
  assert.equal(space.length, 3 * 3 * 2 * 3 * 3);
  assert.equal(new Set(space.map((w) => stableStringify(w))).size, space.length);
  assert.ok(space.some((w) => stableStringify(w) === stableStringify(FROZEN_BASELINE_WEIGHTS)));
});

test('dgm routing ceiling: canonical workload is tie-only (no reachable improvement)', () => {
  const c = searchCeiling(buildWorkload());
  assert.equal(c.schema, CEILING_SCHEMA);
  assert.equal(c.synthetic, true);
  assert.equal(c.spaceSize, 162);
  assert.equal(c.refused, 1, 'only the baseline itself is refused (no delta)');
  assert.equal(c.evaluated, 161);
  assert.deepEqual(c.counts, { improvement: 0, 'tie-archived': 54, regression: 107 });
  assert.equal(c.ceiling, 'tie-archived');
  assert.equal(c.proposalCanImprove, false);
  assert.deepEqual(c.improvementHashes, []);
  assert.equal(c.baseline.heldoutTop1, 20);
  assert.equal(c.best.heldoutTop1, 20);
  assert.equal(c.best.outcome, 'tie-archived');
});

test('dgm routing ceiling: a reachable improvement is found and named', () => {
  const c = searchCeiling(reachableWorkload());
  assert.equal(c.ceiling, 'improvement');
  assert.equal(c.proposalCanImprove, true);
  assert.ok(c.counts.improvement > 0);
  assert.equal(c.improvementHashes.length, c.counts.improvement);
  assert.equal(c.best.outcome, 'improvement');
  assert.equal(c.best.heldoutTop1, 1);
});

test('dgm routing ceiling: live refuses a tie-only space before claiming or calling', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const storeDir = mkdtempSync(pjoin(tmpdir(), 'dgm-ceiling-'));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return wireResponse({ text: strictCandidate(VALID_W) }); };
  await assert.rejects(
    runLiveExperiment({ fetchImpl, apiKey: 'SENTINEL-CEILING', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir }),
    (e) => e.code === 'DGM_CEILING_NO_IMPROVEMENT' && e.ceiling.ceiling === 'tie-archived' && !e.receipt,
  );
  assert.equal(calls, 0, 'no provider contact');
  assert.deepEqual(readdirSync(storeDir), [], 'no attempt claimed, so nothing can strand as uncertain');
});

test('dgm routing ceiling: reachable space passes the gate; claimed identity replays without the gate', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const storeDir = mkdtempSync(pjoin(tmpdir(), 'dgm-ceiling-ok-'));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return wireResponse({ text: strictCandidate(VALID_W), id: 'resp_ceiling_1' }); };
  const out = await runLiveExperiment({ fetchImpl, apiKey: 'SENTINEL-CEILING-OK', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir, workload: reachableWorkload() });
  assert.equal(out.replayed, false);
  assert.equal(calls, 1);
  assert.deepEqual(out.ceiling, { ceiling: 'improvement', proposalCanImprove: true, evaluated: 161, override: false });
  // Same identity, canonical (tie-only) workload, no override: the claimed
  // attempt replays its receipt for free instead of being refused or re-sent.
  const again = await runLiveExperiment({ fetchImpl, apiKey: 'SENTINEL-CEILING-OK', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir });
  assert.equal(again.replayed, true);
  assert.equal(calls, 1);
});

test('dgm routing ceiling: explicit tie override skips enumeration and is recorded', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const storeDir = mkdtempSync(pjoin(tmpdir(), 'dgm-ceiling-override-'));
  const fetchImpl = async () => wireResponse({ text: strictCandidate(VALID_W), id: 'resp_ceiling_2' });
  const out = await runLiveExperiment({ fetchImpl, apiKey: 'SENTINEL-CEILING-OV', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir, ceilingOverride: CEILING_ACCEPT_TIE });
  assert.deepEqual(out.ceiling, { ceiling: 'not-checked', proposalCanImprove: null, evaluated: 0, override: true });
  // A wrong override string is not an override.
  await assert.rejects(
    runLiveExperiment({ fetchImpl, apiKey: 'SENTINEL-CEILING-OV', consent: LIVE_CONSENT, maxSpendUsd: 5, storeDir, label: 'other', ceilingOverride: 'yes' }),
    (e) => e.code === 'DGM_CEILING_NO_IMPROVEMENT',
  );
});
