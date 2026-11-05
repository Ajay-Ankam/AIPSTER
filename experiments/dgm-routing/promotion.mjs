/* DGM lane: reviewable controlled promotion artifact.
 * Human approval is REQUIRED before any application; nothing here applies
 * itself, and production auto-promote is never available (the website
 * promote/execute routes stay 501). Local scope only.
 *
 * Honesty rule: the artifact binds the ACTUAL verified inputs — baseline
 * identity, candidate hash, report digest — and the builder re-verifies them
 * instead of trusting caller-supplied flags. A caller-supplied `eligible`
 * boolean or bare digest is NOT sufficient to claim the gate verified:
 * tampered weights or a tampered report refuse at build time. Application
 * returns a truthful status: without approval it refuses; with approval it
 * either stages a reviewable prepared artifact or writes an explicitly
 * approved LOCAL policy config (never production), and says exactly which.
 */
import { createHash } from 'node:crypto';
import { PROMOTION_SCHEMA, EVAL_VERSION } from './contract.mjs';
import { stableStringify, verifyReport } from './report.mjs';
import { runExperiment } from './runner.mjs';
import { buildWorkload, WORKLOAD_VERSION, WORKLOAD_SEED } from './workload.mjs';

export function hashWeights(weights) {
  return createHash('sha256').update(stableStringify(weights), 'utf8').digest('hex');
}

function promotionFailure(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Build a bound promotion artifact. Verifies (not trusts):
 * - report digest recomputes (tampered report refuses),
 * - report.candidate.weights deep-equals candidateWeights (tampered weights refuse),
 * - report.baseline source matches the pinned baseline identity supplied.
 */
export function buildPromotionArtifact({ candidateWeights, report, reportDigest, baseline, sourceSha = null }) {
  if (!candidateWeights || typeof candidateWeights !== 'object') {
    throw promotionFailure('promotion needs candidate weights', 'DGM_PROMOTION_BAD_INPUT');
  }
  if (!report || typeof report !== 'object' || typeof reportDigest !== 'string') {
    throw promotionFailure('promotion needs the verified report and its digest', 'DGM_PROMOTION_BAD_INPUT');
  }
  if (!verifyReport(report, reportDigest)) {
    throw promotionFailure('report digest does not recompute; refusing tampered report', 'DGM_PROMOTION_UNBOUND');
  }
  if (stableStringify(report.candidate?.weights) !== stableStringify(candidateWeights)) {
    throw promotionFailure('candidate weights do not match the verified report; refusing', 'DGM_PROMOTION_UNBOUND');
  }
  const baselineSource = report.baseline?.source;
  if (!baselineSource || !baseline || baseline.sourceHash !== baselineSource.sha256
      || baseline.policyVersion !== report.baseline?.policyVersion) {
    throw promotionFailure('baseline identity does not match the verified report; refusing', 'DGM_PROMOTION_UNBOUND');
  }
  return {
    schema: PROMOTION_SCHEMA,
    evalVersion: EVAL_VERSION,
    scope: 'local-only',
    approved: false,
    apply: 'manual-human-only',
    eligible: report.promotionEligible === true,
    outcome: report.outcome ?? null,
    baseline: { policyVersion: baseline.policyVersion, sourceHash: baseline.sourceHash },
    candidateWeights: { ...candidateWeights },
    candidateHash: hashWeights(candidateWeights),
    reportDigest,
    sourceSha,
    instructions: 'A human reviewer verifies the report digest, then (only if approved) applies the weights to the LOCAL runner config by hand or via applyPromotion with explicit approval. No automated or production application path exists.',
  };
}

/**
 * Honest application. The artifact's own `eligible` flag is NEVER trusted: a
 * hand edit can flip a boolean without touching the weights hash. The caller
 * supplies the bound actual report, and eligibility is recomputed by
 * re-running the deterministic evaluation on the artifact's weights over the
 * CANONICAL workload built internally — a caller-supplied workload is
 * refused outright, so a crafted 1-item split can never manufacture an
 * improvement. Without humanApproved it REFUSES (never claims applied). With
 * approval it either stages a reviewable prepared record (no writer) or
 * writes an explicitly approved LOCAL policy config file through the injected
 * writer — and returns a status saying exactly which happened. Production is
 * never touched.
 */
export function applyPromotion(artifact, { humanApproved = false, writeConfig = null, report = null, reportDigest = null, workload } = {}) {
  if (!artifact || artifact.schema !== PROMOTION_SCHEMA) {
    throw promotionFailure('unknown promotion artifact', 'DGM_PROMOTION_UNKNOWN');
  }
  if (hashWeights(artifact.candidateWeights) !== artifact.candidateHash) {
    throw promotionFailure('artifact weights do not match their bound hash; refusing tampered artifact', 'DGM_PROMOTION_UNBOUND');
  }
  if (humanApproved !== true) {
    throw promotionFailure('human approval required before applying a candidate promotion artifact', 'DGM_PROMOTION_NEEDS_APPROVAL');
  }
  if (workload !== undefined) {
    throw promotionFailure('caller-supplied workloads are refused; eligibility recomputes on the canonical workload only', 'DGM_PROMOTION_WORKLOAD_REJECTED');
  }
  if (!report || typeof reportDigest !== 'string' || !verifyReport(report, reportDigest)) {
    throw promotionFailure('the bound actual report and its digest are required; refusing unverified artifact', 'DGM_PROMOTION_UNBOUND');
  }
  // Workload identity before digest equality: a self-consistent report over a
  // non-canonical split must name its own reason, not hide behind a mismatch.
  if (report.workload?.version !== WORKLOAD_VERSION || report.workload?.seed !== WORKLOAD_SEED) {
    throw promotionFailure('report workload is not the canonical workload; refusing', 'DGM_PROMOTION_WRONG_WORKLOAD');
  }
  if (reportDigest !== artifact.reportDigest) {
    throw promotionFailure('report digest does not match the artifact binding; refusing', 'DGM_PROMOTION_UNBOUND');
  }
  if (stableStringify(report.candidate?.weights) !== stableStringify(artifact.candidateWeights)) {
    throw promotionFailure('report candidate does not match the artifact weights; refusing', 'DGM_PROMOTION_UNBOUND');
  }
  // Deterministic recompute on canonical inputs: the artifact's eligible flag
  // is ignored entirely. Only a recomputed improvement applies.
  const canonical = buildWorkload();
  const recomputed = runExperiment({ candidate: { weights: { ...artifact.candidateWeights } }, workload: canonical, proposalsUsed: 0 });
  if (recomputed.refused || recomputed.outcome !== 'improvement') {
    throw promotionFailure(`recomputed evaluation is not an improvement (${recomputed.refused ? recomputed.reason : recomputed.outcome}); refusing hand-edited eligibility`, 'DGM_PROMOTION_INELIGIBLE');
  }
  if (recomputed.baseline?.source?.sha256 !== artifact.baseline?.sourceHash) {
    throw promotionFailure('recomputed baseline identity does not match the artifact; refusing', 'DGM_PROMOTION_UNBOUND');
  }
  if (typeof writeConfig !== 'function') {
    return { status: 'prepared', reviewRequired: true, scope: 'local-only', candidateHash: artifact.candidateHash, reportDigest: artifact.reportDigest };
  }
  const config = {
    schema: 'aipster.dgm.routing-local-config/v1',
    scope: 'local-only',
    approvedBy: 'explicit-human-approval',
    baseline: artifact.baseline,
    candidateWeights: { ...artifact.candidateWeights },
    candidateHash: artifact.candidateHash,
    reportDigest: artifact.reportDigest,
    appliedAt: new Date().toISOString(),
  };
  writeConfig(config);
  return { status: 'applied-local-config', reviewRequired: false, scope: 'local-only', candidateHash: artifact.candidateHash, reportDigest: artifact.reportDigest };
}
