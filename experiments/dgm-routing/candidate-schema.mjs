/* DGM lane: restricted declarative candidate schema.
 * Exactly one candidate per experiment. Weights must come from finite
 * allowlists; unknown keys, wrong types, or baseline-identical weights are
 * refused. Pure validation: no eval, no network, no exec. */
import { FROZEN_BASELINE_WEIGHTS } from './baseline.mjs';

// Finite allowlist: single source in the Worker-safe core (eval-core.mjs).
import { WEIGHT_ALLOWLIST } from '../../website/src/dgm/eval-core.mjs';
export { WEIGHT_ALLOWLIST };

const WEIGHT_KEYS = Object.keys(WEIGHT_ALLOWLIST);

export function candidateRefused(reason, detail) {
  return { refused: true, reason, detail };
}

export function isRefusal(v) {
  return !!v && typeof v === 'object' && v.refused === true;
}

/**
 * Validate a parsed candidate value. Returns {candidate:{weights}} or refusal.
 * Accepted shape: { weights: { EXACT_TOKEN, ONLINE, FRESHNESS_MAX, OWNED, HEADROOM } }
 */
export function validateCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return candidateRefused('DGM_CANDIDATE_BAD_BODY', 'candidate must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'weights') {
    return candidateRefused('DGM_CANDIDATE_BAD_BODY', 'candidate must carry exactly { weights }');
  }
  const w = value.weights;
  if (!w || typeof w !== 'object' || Array.isArray(w)) {
    return candidateRefused('DGM_CANDIDATE_BAD_BODY', 'weights must be an object');
  }
  const wkeys = Object.keys(w).sort();
  if (wkeys.join(',') !== [...WEIGHT_KEYS].sort().join(',')) {
    return candidateRefused('DGM_CANDIDATE_BAD_WEIGHTS', `weights must set exactly: ${WEIGHT_KEYS.join(', ')}`);
  }
  for (const k of WEIGHT_KEYS) {
    const v = w[k];
    if (!Number.isSafeInteger(v) || !WEIGHT_ALLOWLIST[k].includes(v)) {
      return candidateRefused('DGM_CANDIDATE_BAD_WEIGHTS', `weights.${k} must be one of ${WEIGHT_ALLOWLIST[k].join(', ')}`);
    }
  }
  const differs = WEIGHT_KEYS.some((k) => w[k] !== FROZEN_BASELINE_WEIGHTS[k]);
  if (!differs) {
    return candidateRefused('DGM_CANDIDATE_NO_DELTA', 'candidate weights are identical to the frozen baseline; an experiment needs an actual delta');
  }
  return { candidate: { weights: { ...w } } };
}
