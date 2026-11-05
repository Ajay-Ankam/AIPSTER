/* DGM lane: frozen baseline routing policy (route/v1).
 * The baseline is the authoritative scorer in website/src/routing/policy.mjs.
 * This module pins version + weights + scorer SOURCE CONTENT HASH and REFUSES
 * on drift: a code change that keeps the constants but moves the scorer can
 * never silently shift the baseline. Source identity (file + hashes) flows
 * into every report. No network, no exec. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTING_POLICY_VERSION,
  ROUTING_SCORE,
  scoreCandidates,
} from '../../website/src/routing/policy.mjs';
import { BASELINE_POLICY_VERSION } from './contract.mjs';

export const FROZEN_BASELINE_WEIGHTS = Object.freeze({
  EXACT_TOKEN: 50,
  ONLINE: 30,
  FRESHNESS_MAX: 20,
  OWNED: 10,
  HEADROOM: 5,
});

// SHA-256 over the exact source bytes of the scorer, verified against base
// f5b4572 (git blob 4c7fecd76a2c26c0170b06169917b223e77dc254 matches worktree).
export const POLICY_SOURCE_FILE = 'website/src/routing/policy.mjs';
export const POLICY_SOURCE_SHA256 = '13e9eb14bd2bc8d55124ebc493ed7d9373acf154021d2394b8cbef2dab4e6571';
export const POLICY_SOURCE_BLOB = '4c7fecd76a2c26c0170b06169917b223e77dc254';

const POLICY_ABS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', POLICY_SOURCE_FILE);

export function sourceHashOfScorer() {
  return createHash('sha256').update(readFileSync(POLICY_ABS)).digest('hex');
}

export function assertBaselinePinned() {
  if (ROUTING_POLICY_VERSION !== BASELINE_POLICY_VERSION) {
    throw Object.assign(
      new Error(`baseline drift: policy ${ROUTING_POLICY_VERSION} !== pinned ${BASELINE_POLICY_VERSION}`),
      { code: 'DGM_BASELINE_DRIFT' },
    );
  }
  for (const [k, v] of Object.entries(FROZEN_BASELINE_WEIGHTS)) {
    if (ROUTING_SCORE[k] !== v) {
      throw Object.assign(
        new Error(`baseline drift: ROUTING_SCORE.${k}=${ROUTING_SCORE[k]} !== pinned ${v}`),
        { code: 'DGM_BASELINE_DRIFT' },
      );
    }
  }
  const sourceHash = sourceHashOfScorer();
  if (sourceHash !== POLICY_SOURCE_SHA256) {
    throw Object.assign(
      new Error(`baseline drift: scorer source hash ${sourceHash} !== pinned ${POLICY_SOURCE_SHA256}`),
      { code: 'DGM_BASELINE_DRIFT' },
    );
  }
  return {
    policyVersion: ROUTING_POLICY_VERSION,
    weights: { ...FROZEN_BASELINE_WEIGHTS },
    source: { file: POLICY_SOURCE_FILE, sha256: sourceHash, blob: POLICY_SOURCE_BLOB },
  };
}

/** Real baseline execution: delegates to the authoritative scorer. */
export function scoreBaseline(candidates, features) {
  assertBaselinePinned();
  return scoreCandidates(candidates, features);
}
