/* Built with Meta Muse. */
// DGM local routing-experiment contract (additive, pure, no routes).
//
// This module states the local experiment's identity and its honest boundary:
// the website preview slice evaluates the deterministic fixture table ONLY
// (`evaluation: 'fixture'`, hardcoded scores), and preview execute/promote
// stay refused 501 with no code path enabling them (see ./preview.mjs
// DISABLED_ACTIONS and ./router.mjs disabledAction). Genuine execution or
// promotion backends are NOT wired here; the local experiment runner lives at
// experiments/dgm-routing/ and its promotion artifact is local-only,
// manual-human-only, and never touches production.
export const ROUTING_EXPERIMENT_SCHEMA = 'aipster.dgm.routing-experiment/v1';
export const ROUTING_REPORT_SCHEMA = 'aipster.dgm.routing-report/v1';
export const ROUTING_PROMOTION_SCHEMA = 'aipster.dgm.routing-promotion/v1';
export const ROUTING_EVAL_VERSION = 'dgm-routing-eval/v1';
export const ROUTING_BASELINE_POLICY = 'route/v1';

// Fail-closed execution boundary: these map exactly the preview slice's
// disabled actions for routing work. Both stay refused; there is no enabler.
export const ROUTING_DISABLED_ACTIONS = Object.freeze(['execute', 'promote']);

export function routingExperimentBoundary() {
  return {
    schema: ROUTING_EXPERIMENT_SCHEMA,
    evalVersion: ROUTING_EVAL_VERSION,
    baselinePolicy: ROUTING_BASELINE_POLICY,
    evaluation: 'local-synthetic',
    websiteExecute: 'refused-501',
    websitePromote: 'refused-501',
    productionAutoPromote: 'never',
  };
}
