/* DGM lane: lane-owned path helpers.
 * Durable attempt receipts must never land in version control: the root
 * .gitignore covers experiments/dgm-routing/artifacts/, so the default live
 * attempt store lives under it. Reports and promotion artifacts are written
 * to the same ignored tree (local-only runtime state, delivered via evidence
 * files, never committed).
 */
import { join } from 'node:path';

export function artifactsDir(root) {
  return join(root, 'artifacts');
}

export function defaultStoreDir(root) {
  return join(artifactsDir(root), 'attempts');
}
