/* DGM lane: live experiment orchestration (explicit consent + budget gate).
 *
 * Live execution requires ALL of: the exact consent string, a positive
 * per-call spend budget, and an ephemeral server-side caller key passed as an
 * argument (the CLI reads it from DGM_ROUTING_API_KEY at the edge; this
 * module never reads files, env, or credential stores). Dry-run is the
 * default path and never reaches this module. No call is made by lane code
 * except through here, and tests only ever pass an injected fetchImpl.
 *
 * Spend-once semantics: the attempt identity (baseline, workload, model,
 * prompt hash, budget, label) is atomically claimed BEFORE any network
 * contact. A rerun with an unchanged request replays the persisted receipt
 * and never spends again; a deliberate fresh experiment needs an explicit
 * new label. Uncertain and invalid-candidate outcomes persist their sanitized
 * receipts too — including the safe provider receipt (usage, response ID,
 * observed model or null) when the provider succeeded but the text was
 * unusable. A missing observed model is recorded null/unverified, never the
 * pinned model as a fabricated fallback.
 */
import { createHash } from 'node:crypto';
import { buildWorkload, WORKLOAD_VERSION, WORKLOAD_SEED } from './workload.mjs';
import { runExperiment } from './runner.mjs';
import { assertBaselinePinned } from './baseline.mjs';
import {
  buildLivePrompt,
  preflightProposal,
  proposeLiveRouting,
  acceptLiveProposal,
  classifyRoutingFailure,
} from './meta-adapter.mjs';
import { PROPOSAL_MODEL } from './contract.mjs';
import { buildReport } from './report.mjs';
import { buildPromotionArtifact } from './promotion.mjs';
import { attemptExists, attemptIdFor, claimAttempt, readReceipt, releaseUnsentClaim, writeReceipt } from './attempts.mjs';
import { assertProposalCanImprove } from './ceiling.mjs';

export const LIVE_CONSENT = 'YES-LIVE-SPEND';

function consentFailure(message, code) {
  return Object.assign(new Error(message), { code });
}

const promptHashOf = (prompt) => createHash('sha256').update(prompt, 'utf8').digest('hex');

/**
 * Run one live experiment end-to-end. Returns { replayed, report, digest,
 * promotion, experiment, receipt, spend }. The key is used for the single
 * bounded call only and never enters any returned or written structure.
 */
export async function runLiveExperiment({
  fetchImpl, apiKey, consent, maxSpendUsd, workload = null, sourceSha = null,
  generatedAt = null, label = 'default', storeDir = null, ceilingOverride = null,
} = {}) {
  if (consent !== LIVE_CONSENT) {
    throw consentFailure('live execution requires explicit consent (pass the documented consent string)', 'DGM_ROUTING_NO_CONSENT');
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw consentFailure('live execution requires an ephemeral server-side caller key argument', 'DGM_ROUTING_NOT_CONFIGURED');
  }
  const prompt = buildLivePrompt();
  const preflight = preflightProposal(prompt, maxSpendUsd);
  const pin = assertBaselinePinned();
  const wl = workload || buildWorkload();
  const attemptFields = {
    baselinePolicy: pin.policyVersion,
    baselineSourceHash: pin.source.sha256,
    workloadVersion: WORKLOAD_VERSION,
    workloadSeed: WORKLOAD_SEED,
    model: PROPOSAL_MODEL,
    promptHash: promptHashOf(prompt),
    maxSpendUsd,
    label,
  };

  // Durable claim before network (repair: no repeated spend on rerun,
  // uncertainty persisted). Without a store dir the call cannot be admitted:
  // replay and receipt persistence are mandatory, not optional.
  if (typeof storeDir !== 'string' || storeDir.length === 0) {
    throw consentFailure('live execution requires an attempt store directory', 'DGM_ATTEMPT_NO_STORE');
  }
  // Ceiling gate BEFORE the attempt claim and any network contact: when
  // exhaustive offline enumeration shows no allowlisted candidate can be an
  // improvement, a paid proposal can at best tie, so it is refused unless
  // the caller explicitly accepts a tie-only result. A refusal claims
  // nothing, so it can never strand an uncertain attempt. An identity that
  // is already claimed skips the gate and keeps its existing semantics
  // (free receipt replay, or the uncertain refusal); neither can spend.
  const alreadyClaimed = attemptExists(storeDir, attemptIdFor(attemptFields));
  let ceiling = alreadyClaimed ? null : assertProposalCanImprove(wl, { override: ceilingOverride });
  const claim = claimAttempt(storeDir, attemptFields);
  if (claim.fresh && ceiling === null) {
    // The identity vanished between the probe and the claim (nothing in this
    // lane deletes attempts, but never trust that): gate the fresh claim now.
    // Nothing has been sent yet, so a refusal releases the claim it just made.
    try {
      ceiling = assertProposalCanImprove(wl, { override: ceilingOverride });
    } catch (e) {
      releaseUnsentClaim(storeDir, claim.attempt.attemptId);
      throw e;
    }
  }
  if (!claim.fresh) {
    const receipt = readReceipt(storeDir, claim.attempt.attemptId);
    if (receipt) {
      return { replayed: true, attemptId: claim.attempt.attemptId, receipt, report: null, digest: null, promotion: null, experiment: null, spend: null };
    }
    // Claimed but no receipt: a prior run may have spent. Never re-spend;
    // persist nothing new, report the gap as uncertain.
    throw Object.assign(
      new Error('prior attempt reserved without a receipt; treating as uncertain with no duplicate sent'),
      { code: 'DGM_ATTEMPT_UNCERTAIN', accounting: { providerContact: 'unknown', acceptance: 'unknown', billing: 'unknown' } },
    );
  }
  const attemptId = claim.attempt.attemptId;
  const spendCtx = {
    perCallWorstCaseUsd: preflight.worstCaseSpendUsd,
    perCallBudgetUsd: maxSpendUsd,
    aggregate: 'none — per-call budget only in this slice',
  };

  let live;
  try {
    live = await proposeLiveRouting({ fetchImpl, apiKey, prompt, maxSpendUsd });
  } catch (e) {
    const receipt = writeReceipt(storeDir, attemptId, {
      state: 'uncertain',
      provider: { model: null, modelVerified: false, responseId: null, usage: null },
      failure: { code: e.code || 'DGM_ROUTING_UPSTREAM', accounting: classifyRoutingFailure(e), httpStatus: e.httpStatus ?? null },
      spend: spendCtx,
      note: 'no usable provider output; quarantined, no duplicate sent',
    }, [apiKey]);
    throw Object.assign(
      new Error(`live proposal failed: ${e.code || 'UNKNOWN'}; receipt ${attemptId} persisted as uncertain`),
      { code: e.code || 'DGM_ROUTING_UPSTREAM', accounting: classifyRoutingFailure(e), receipt },
    );
  }

  const accepted = acceptLiveProposal(live);
  const providerReceipt = {
    model: accepted.refused ? (typeof live.model === 'string' ? live.model : null) : accepted.provenance.model,
    modelVerified: accepted.refused ? (typeof live.model === 'string') : accepted.provenance.modelVerified,
    responseId: live.responseId,
    usage: live.usage,
  };
  if (accepted.refused) {
    // Provider success with unusable text: retain the safe provider receipt
    // and accepted accounting — the call counts as sent, never as clean.
    const receipt = writeReceipt(storeDir, attemptId, {
      state: 'invalid-candidate',
      provider: providerReceipt,
      failure: {
        code: accepted.reason,
        detail: accepted.detail,
        accounting: { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' },
      },
      spend: spendCtx,
      note: 'provider call accepted; candidate text unusable, no duplicate sent',
    }, [apiKey]);
    throw Object.assign(
      new Error(`live proposal carried no usable candidate (${accepted.reason}); receipt ${attemptId} persisted`),
      { code: accepted.reason, receipt, provider: providerReceipt },
    );
  }

  // Post-provider stages can still fail (evaluator refusal, report or
  // promotion error) AFTER a successful, possibly chargeable call. The safe
  // provider receipt and usage must not be lost with the throw: persist an
  // uncertain receipt first, then rethrow with it attached.
  let experiment, report, digest, promotion;
  try {
    experiment = runExperiment({ candidate: accepted.candidate, workload: wl, proposalsUsed: 1 });
    if (experiment.refused) {
      throw consentFailure(`experiment refused: ${experiment.reason}`, experiment.reason);
    }
    ({ report, digest } = buildReport({
      experiment,
      workloadVersion: WORKLOAD_VERSION,
      workloadSeed: WORKLOAD_SEED,
      proposalProvenance: accepted.provenance,
      sourceSha,
      generatedAt: generatedAt || new Date().toISOString(),
    }));
    promotion = buildPromotionArtifact({
      candidateWeights: experiment.candidate.weights,
      report,
      reportDigest: digest,
      baseline: { policyVersion: pin.policyVersion, sourceHash: pin.source.sha256 },
      sourceSha,
    });
  } catch (e) {
    const receipt = writeReceipt(storeDir, attemptId, {
      state: 'uncertain',
      provider: providerReceipt,
      failure: {
        code: (e && e.code) || 'DGM_POST_PROVIDER_FAILURE',
        accounting: { providerContact: 'sent', acceptance: 'accepted', billing: 'possibly-chargeable' },
      },
      spend: spendCtx,
      note: 'provider call succeeded; evaluator/report/promotion failed afterwards — quarantined, no duplicate sent',
    }, [apiKey]);
    throw Object.assign(
      new Error(`post-provider stage failed (${(e && e.code) || 'UNKNOWN'}); receipt ${attemptId} persisted as uncertain`),
      { code: (e && e.code) || 'DGM_POST_PROVIDER_FAILURE', receipt, provider: providerReceipt, cause: e },
    );
  }
  const receipt = writeReceipt(storeDir, attemptId, {
    state: 'succeeded',
    provider: providerReceipt,
    outcome: { label: experiment.outcome, detail: experiment.outcomeDetail, heldoutBaselineTop1: experiment.baseline.heldout.top1Hits, heldoutCandidateTop1: experiment.candidate.heldout.top1Hits },
    reportDigest: digest,
    spend: { ...spendCtx, reportedUsage: live.usage },
    note: 'single bounded call; replay returns this receipt without spending',
  }, [apiKey]);
  // `ceiling` is always set here: an already-claimed identity returns or
  // throws in the replay branch above, before reaching this point.
  const ceilingSummary = { ceiling: ceiling.ceiling, proposalCanImprove: ceiling.proposalCanImprove, evaluated: ceiling.evaluated, override: ceiling.ceiling === 'not-checked' };
  return { replayed: false, attemptId, report, digest, promotion, experiment, receipt, spend: spendCtx, ceiling: ceilingSummary };
}
