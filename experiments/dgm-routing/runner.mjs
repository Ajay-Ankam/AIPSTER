/* DGM lane: bounded local experiment runner.
 * Executes the frozen baseline AND one allowlisted candidate over the fixed
 * synthetic workload using REAL routing decisions (scoreCandidates for the
 * baseline; a weight-parameterized mirror for the candidate, tied to the
 * baseline by test). Measures synthetic quality + guardrails. No eval, no
 * shell, no network, no credentials, no recursion (candidate schema has no
 * field that can name further work). */
import { createHash } from 'node:crypto';
import { scoreBaseline, FROZEN_BASELINE_WEIGHTS, assertBaselinePinned } from './baseline.mjs';
import { validateCandidate, isRefusal } from './candidate-schema.mjs';
import { assertSplitsIndependent } from './workload.mjs';
import { stableStringify } from './report.mjs';
import { EVAL_VERSION } from './contract.mjs';

// The weight-parameterized route/v1 mirror lives in the Worker-safe core so
// the site's cron self-test and this lane share one implementation.
export { scoreWithWeights } from '../../website/src/dgm/eval-core.mjs';
import { scoreWithWeights } from '../../website/src/dgm/eval-core.mjs';

function orderOf(result) {
  return result.ranked.map((r) => r.alias);
}

function measure(items, scoreFn) {
  // Returns per-item orders + synthetic quality vs oracle-best (NEW metric,
  // synthetic-only: NOT a production improvement signal). itemRanks carries
  // the 1-based rank of the oracle-best per item for regression analysis.
  let top1 = 0;
  let rankSum = 0;
  const orders = [];
  const itemRanks = [];
  for (const item of items) {
    const res = scoreFn(item.descriptors, item.features);
    const order = orderOf(res);
    orders.push(order);
    const rank = order.indexOf(item.oracleBest) + 1;
    itemRanks.push(rank);
    if (rank === 1) top1 += 1;
    rankSum += rank;
  }
  return {
    n: items.length,
    top1Hits: top1,
    top1Rate: items.length ? top1 / items.length : null,
    meanRankOfOracleBest: items.length ? rankSum / items.length : null,
    orders,
    itemRanks,
  };
}

/**
 * Outcome rule (stated objective: synthetic held-out top-1 gain with no
 * regressions anywhere). The criterion is the full narrow form: EVERY
 * held-out item's oracle-best rank must not worsen — not just the baseline
 * top-1 items. Nothing here measures real-fabric quality; the oracle is a
 * fixed synthetic preference, so no outcome is a real-fabric improvement
 * claim regardless of the label.
 * - 'improvement': strict held-out top-1 gain AND zero rank regressions.
 * - 'tie-archived': equal top-1 with zero rank regressions. Archived as
 *   evidence, NEVER called an improvement.
 * - 'regression': everything else.
 * Only 'improvement' is promotion-eligible. Nothing auto-promotes.
 */
export function decideOutcome(heldBase, heldCand) {
  const worsened = heldBase.itemRanks.filter((r, i) => heldCand.itemRanks[i] > r).length;
  const noItemRegressions = worsened === 0;
  const strictGain = heldCand.top1Hits > heldBase.top1Hits;
  const tie = heldCand.top1Hits === heldBase.top1Hits;
  if (strictGain && noItemRegressions) {
    return { outcome: 'improvement', eligible: true, detail: `synthetic held-out top-1 ${heldBase.top1Hits}->${heldCand.top1Hits} with zero rank regressions (not a real-fabric claim)` };
  }
  if (tie && noItemRegressions) {
    return { outcome: 'tie-archived', eligible: false, detail: `synthetic held-out top-1 tied at ${heldBase.top1Hits}; archived, not an improvement` };
  }
  return { outcome: 'regression', eligible: false, detail: `synthetic held-out top-1 ${heldBase.top1Hits}->${heldCand.top1Hits}; ${worsened} rank regression(s)` };
}

/**
 * Run one experiment. opts: { candidate (parsed object), workload, proposalsUsed }
 * proposalsUsed counts injected Meta proposals consumed (max 1); the runner
 * itself never calls any provider.
 */
export function runExperiment({ candidate: rawCandidate, workload, proposalsUsed = 0 } = {}) {
  if (!workload || !Array.isArray(workload.train) || !Array.isArray(workload.heldout)) {
    throw Object.assign(new Error('fixed workload required'), { code: 'DGM_WORKLOAD_REQUIRED' });
  }
  if (proposalsUsed > 1) {
    throw Object.assign(new Error('at most one proposal per experiment'), { code: 'DGM_PROPOSAL_BUDGET' });
  }
  const checked = validateCandidate(rawCandidate);
  if (isRefusal(checked)) return { refused: true, ...checked };
  const { candidate } = checked;

  const base = (descriptors, features) => scoreBaseline(descriptors, features);
  const cand = (descriptors, features) => scoreWithWeights(descriptors, features, candidate.weights);

  // Actual execution, twice each (G2 replay determinism compares the repeats).
  const trainBase = measure(workload.train, base);
  const trainBase2 = measure(workload.train, base);
  const trainCand = measure(workload.train, cand);
  const trainCand2 = measure(workload.train, cand);
  const heldBase = measure(workload.heldout, base);
  const heldCand = measure(workload.heldout, cand);

  // Guardrails (preserved acceptance shape: ranking-contract integrity first).
  const permutationOk = [...trainBase.orders, ...trainCand.orders, ...heldBase.orders, ...heldCand.orders]
    .every((order, idx) => {
      const pool = idx < trainBase.orders.length * 2
        ? workload.train[idx % workload.train.length]
        : workload.heldout[(idx - trainBase.orders.length * 2) % workload.heldout.length];
      const want = new Set(pool.descriptors.map((d) => d.alias));
      return order.length === want.size && order.every((a) => want.has(a)) && new Set(order).size === order.length;
    });
  const deterministicOk =
    JSON.stringify(trainBase.orders) === JSON.stringify(trainBase2.orders) &&
    JSON.stringify(trainCand.orders) === JSON.stringify(trainCand2.orders);
  const splits = assertSplitsIndependent(workload);
  const guardrails = [
    { name: 'permutation_integrity', passed: permutationOk, evidence: permutationOk ? 'every ranking is an exact duplicate-free permutation of its eligible set' : 'ranking dropped, duplicated, or invented an alias' },
    { name: 'replay_determinism', passed: deterministicOk, evidence: deterministicOk ? 'repeat execution reproduced every order' : 'repeat execution diverged' },
    { name: 'allowlist_conformance', passed: true, evidence: 'candidate passed validateCandidate (finite allowlisted weights, real delta)' },
    { name: 'split_independence', passed: splits.disjoint, evidence: splits.disjoint ? 'held-out split repeats no train item' : `${splits.crossDuplicates} cross-split duplicate(s), ${splits.idCollisions} id collision(s)` },
  ];

  // Stated objective with teeth: strict held-out top-1 gain, mean rank not
  // worse, zero item regressions, all guardrails green. A tie archives.
  const verdict = guardrails.every((g) => g.passed)
    ? decideOutcome(heldBase, heldCand)
    : { outcome: 'regression', eligible: false, detail: 'guardrail failure blocks any improvement claim' };

  const strip = (m) => ({ n: m.n, top1Hits: m.top1Hits, top1Rate: m.top1Rate, meanRankOfOracleBest: m.meanRankOfOracleBest });
  const pin = assertBaselinePinned();
  // Frozen finalist: the evaluated candidate is hashed at run time so the
  // promotion artifact and report bind the exact weights that ran.
  const candidateHash = createHash('sha256').update(stableStringify({ ...candidate.weights }), 'utf8').digest('hex');
  return {
    refused: false,
    evalVersion: EVAL_VERSION,
    baseline: { policyVersion: pin.policyVersion, weights: { ...pin.weights }, source: pin.source, train: strip(trainBase), heldout: strip(heldBase) },
    candidate: { weights: { ...candidate.weights }, hash: candidateHash, train: strip(trainCand), heldout: strip(heldCand) },
    guardrails,
    outcome: verdict.outcome,
    outcomeDetail: verdict.detail,
    promotionEligible: verdict.eligible,
    proposalsUsed,
  };
}
