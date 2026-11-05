/* DGM lane: immutable hashed report. Canonical JSON (sorted keys) + SHA-256.
 * The digest covers the full comparison; any edit invalidates it. */
import { createHash } from 'node:crypto';
import { REPORT_SCHEMA, EVAL_VERSION } from './contract.mjs';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Build { report, digest }. sourceSha names the tree the code ran from. */
export function buildReport({ experiment, workloadVersion, workloadSeed, proposalProvenance = null, sourceSha = null, generatedAt = null }) {
  const report = {
    schema: REPORT_SCHEMA,
    evalVersion: EVAL_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    sourceSha,
    workload: { version: workloadVersion, seed: workloadSeed },
    baseline: experiment.baseline,
    candidate: experiment.candidate,
    guardrails: experiment.guardrails,
    outcome: experiment.outcome,
    outcomeDetail: experiment.outcomeDetail,
    promotionEligible: experiment.promotionEligible,
    proposalsUsed: experiment.proposalsUsed,
    proposalProvenance,
    scopeNote: 'local synthetic evaluation only; the top-1 oracle is a proposed synthetic proxy, not a preexisting acceptance metric or real-fabric quality proof; the public deterministic held-out is a regression split, not secret untouched audit data, and repeated development can tune it; report-only output with human review, no sealed final audit and no full DGM process claimed; website execute/promote remain fail-closed (501); ties archive as evidence and are never called improvement',
  };
  const digest = sha256Hex(stableStringify(report));
  return { report, digest };
}

export function verifyReport(report, digest) {
  if (!report || typeof report !== 'object') return false;
  return sha256Hex(stableStringify(report)) === digest;
}
