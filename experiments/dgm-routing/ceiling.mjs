/* DGM lane: search-space ceiling by exhaustive enumeration.
 * The candidate allowlist (candidate-schema.mjs) is finite and the evaluator
 * is deterministic, so the BEST ACHIEVABLE outcome of any proposal is
 * computable offline, for free, before any provider is contacted. A live
 * proposal over a space whose ceiling is not 'improvement' can at most tie:
 * it spends money for a result that is never promotion-eligible.
 *
 * Synthetic-only, like every outcome in this lane: the ceiling describes the
 * synthetic proxy over the canonical workload, not real-fabric quality.
 * Pure: no network, no credentials, no exec, no writes. */
import { createHash } from 'node:crypto';
import { runExperiment } from './runner.mjs';
import { stableStringify } from './report.mjs';
import { EVAL_VERSION } from './contract.mjs';
// Enumeration and ordering are the Worker-safe core's: one implementation
// for the site's cron self-test and this lane, so both name the same best.
import { enumerateAllowlist, candidateBetter, weightsKey } from '../../website/src/dgm/eval-core.mjs';

export { enumerateAllowlist };

export const CEILING_SCHEMA = 'aipster.dgm.routing-ceiling/v1';
export const CEILING_ACCEPT_TIE = 'ACCEPT-TIE-CEILING';

/**
 * Evaluate every allowlisted candidate on `workload` and report the ceiling.
 * @returns {{schema, evalVersion, spaceSize, evaluated, refused,
 *   counts:{improvement,'tie-archived',regression}, baseline:{heldoutTop1, trainTop1},
 *   best:{weights,hash,outcome,heldoutTop1,heldoutMeanRank,trainTop1}|null,
 *   improvementHashes:string[], ceiling:'improvement'|'tie-archived'|'regression'|'empty',
 *   proposalCanImprove:boolean, synthetic:true}}
 */
export function searchCeiling(workload) {
  const space = enumerateAllowlist();
  const counts = { improvement: 0, 'tie-archived': 0, regression: 0 };
  let refused = 0;
  let best = null;
  let baseline = null;
  const improvementHashes = [];
  for (const weights of space) {
    const r = runExperiment({ candidate: { weights }, workload, proposalsUsed: 0 });
    if (r.refused) { refused += 1; continue; }
    if (!baseline) baseline = { heldoutTop1: r.baseline.heldout.top1Hits, trainTop1: r.baseline.train.top1Hits };
    counts[r.outcome] += 1;
    const entry = {
      weights: { ...weights },
      weightsKey: weightsKey(weights),
      hash: createHash('sha256').update(stableStringify(weights), 'utf8').digest('hex'),
      outcome: r.outcome,
      heldoutTop1: r.candidate.heldout.top1Hits,
      heldoutMeanRank: r.candidate.heldout.meanRankOfOracleBest,
      trainTop1: r.candidate.train.top1Hits,
    };
    if (r.outcome === 'improvement') improvementHashes.push(entry.hash);
    if (!best || candidateBetter(entry, best)) best = entry;
  }
  return {
    schema: CEILING_SCHEMA,
    evalVersion: EVAL_VERSION,
    spaceSize: space.length,
    evaluated: space.length - refused,
    refused,
    counts,
    baseline,
    best,
    improvementHashes,
    ceiling: best ? best.outcome : 'empty',
    proposalCanImprove: counts.improvement > 0,
    synthetic: true,
  };
}

/**
 * Gate for paid proposals. Refuses (throws DGM_CEILING_NO_IMPROVEMENT) when
 * no allowlisted candidate can be an improvement, unless the caller passes
 * the explicit CEILING_ACCEPT_TIE override (e.g. a deliberate transport
 * smoke where a tie is the expected, accepted result). Returns the ceiling.
 */
export function assertProposalCanImprove(workload, { override = null } = {}) {
  // An explicit override skips enumeration entirely: the caller has already
  // accepted that the result may only tie, and a malformed workload must
  // keep failing in the evaluator where its receipt semantics live.
  if (override === CEILING_ACCEPT_TIE) {
    return { schema: CEILING_SCHEMA, ceiling: 'not-checked', proposalCanImprove: null, evaluated: 0, synthetic: true };
  }
  const ceiling = searchCeiling(workload);
  if (!ceiling.proposalCanImprove) {
    throw Object.assign(
      new Error(`search-space ceiling is '${ceiling.ceiling}': none of ${ceiling.evaluated} allowlisted candidates can be an improvement, so a proposal cannot produce an eligible result; no call sent. Widen the search space, or pass the ${CEILING_ACCEPT_TIE} override for a deliberate tie-accepting smoke.`),
      { code: 'DGM_CEILING_NO_IMPROVEMENT', ceiling },
    );
  }
  return ceiling;
}
