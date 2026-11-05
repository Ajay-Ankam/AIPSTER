/* DGM lane: shared contract constants for the bounded local routing experiment.
 * Scope: local-only synthetic evaluation. No network, no credentials, no exec.
 * The website mirror (website/src/dgm/routing-experiment.mjs) carries the same
 * EVAL_VERSION; a maintained test asserts they match. */

export const ROUTING_EXPERIMENT_SCHEMA = 'aipster.dgm.routing-experiment/v1';
export const REPORT_SCHEMA = 'aipster.dgm.routing-report/v1';
export const PROMOTION_SCHEMA = 'aipster.dgm.routing-promotion/v1';
export const EVAL_VERSION = 'dgm-routing-eval/v1';
export const BASELINE_POLICY_VERSION = 'route/v1';

// One Meta proposal attempt per experiment, contributor mode, per PRD.
export const PROPOSAL_MODEL = 'muse-spark-1.3-contributor';
export const PROPOSAL_MAX_OUTPUT_TOKENS = 512;
export const PROPOSAL_DEADLINE_MS = 60 * 1000;
export const PROPOSAL_MAX_TEXT_CHARS = 8192;
