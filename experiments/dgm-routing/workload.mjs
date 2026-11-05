/* DGM lane: fixed synthetic train/held-out workload for routing experiments.
 * The implementation lives in website/src/dgm/eval-core.mjs (pure,
 * Worker-safe) so the site's daily cron self-test and this local lane
 * evaluate the identical workload. Re-exported unchanged. */
export {
  WORKLOAD_SEED, TRAIN_SIZE, HELDOUT_SIZE, WORKLOAD_VERSION,
  oracleBest, buildWorkload, assertSplitsIndependent,
} from '../../website/src/dgm/eval-core.mjs';
