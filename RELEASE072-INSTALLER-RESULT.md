# RELEASE072 installer-trigger correction — result

Owner: Muse 4cae1d81 (Contributor/allowAll), sole preparation ownership.
Worktree: `task-4/lanes/muse-installer-trigger072-20261104`,
branch `muse/installer-trigger072-20261104`, from PR103 head
`c4a1d90db4a3d2104eb8d79571b71dc31d180f21` (PR103 branch/head untouched).
No push. No gate/policy/trust/permission/hold/secret/runtime change.

## Gap (reproduced before fix)

`website/scripts/release-gate.mjs` `commonGates` requires the
`Build and qualify Windows installer` check at the PR head whenever
`isWorkerApplicable(changedFiles)` is true, producer-bound to
`.github/workflows/worker-installer-build.yml`. But that workflow's
`pull_request` paths covered only `local-worker/**`, `LICENSE`, and its
own file — while gate applicability (`WORKER_PATH_PATTERNS`, mirrored
from `local-worker-checks.yml`) also covers `website/src/**`,
`website/migrations/**`, `website/tests/d1-shim.mjs`,
`website/scripts/pairing-e2e-bridge.mjs`, `website/package*.json`,
`.github/workflows/local-worker-checks.yml`, and `NOTICE`. A PR touching
only the missing paths could never produce the required installer run.

Focused test `website/tests/worker-installer-trigger.test.mjs` (new,
owned) reproduced it: 11 failures pre-fix (pattern-parity diff plus one
per missing path), 25/25 green post-fix. Related suites unmodified and
green: `release-preflight` + `release-gate` + `deploy-workflow`
(129/129). PR103's 171-test evidence reused for unchanged code; no broad
suite, no local installer build.

## Fix (owned files only)

`.github/workflows/worker-installer-build.yml`: PR paths widened to exact
parity with `WORKER_PATH_PATTERNS` plus the workflow's own file.
Retained: ordinary `pull_request` semantics, `workflow_dispatch` manual
fallback, `contents: read` with no write grants, `persist-credentials:
false` checkout, concurrency group + cancel-in-progress, pinned actions
(checkout/setup-uv/upload-artifact SHAs asserted in test), the
gate-bound job name `Build and qualify Windows installer`, no
environment/release publication. Untrusted fork code still receives no
write/secrets privilege — nothing was weakened to hide missing checks;
the gate is unchanged and still fails closed when the run is absent.

## Affected merged history (read-only GitHub metadata)

- PR83 (MERGED 21:16Z, fork `aj/catalog-gguf-variants`, head `01fce78`):
  touches `website/src/**` incl `website/src/worker.js` → worker-applicable.
- PR97 (MERGED 22:20Z, head `d494f11`, branch since moved on):
  touches `website/src/lib/catalog/*` → worker-applicable.
- PR99 (MERGED 22:43Z, head `f39736b` = current tip of
  `fix/catalog-compat-defects-20261103`): touches `website/src/**` →
  worker-applicable.
- Check-runs on all three head SHAs: only `Public site asset and build
  checks` + `mock-install` (success). Zero installer runs — the gap above
  is why none could exist.
- Ref availability: PR83's fork branch is gone (only read-only
  `refs/pull/83/head`); PR97's head is orphaned (only
  `refs/pull/97/head`); PR99's head equals the live branch tip
  `f39736b`. `refs/pull/*/head` are read-only and not dispatch targets.

## Backfill feasibility (no code execution, no branch/dispatch by this lane)

- Exact-head installer evidence for `01fce78`/`d494f11`/`f39736b` has a
  genuine blocker: closed PRs fire no `pull_request` events, and the
  gate's producer binding (`verifyCheckProducers`) requires a real
  Actions run of the installer workflow file at that exact head — that
  linkage cannot be manufactured post-hoc for these SHAs. A Checks-API
  write would fail producer binding; no such write was attempted.
- Smallest supported path (operator decision, not this lane): after the
  corrected workflow merges, a `workflow_dispatch` run on a main tree
  containing their content yields real installer evidence covering their
  code — forward-looking, not exact-head-bound. Whether the release
  accepts that for the candidate is a controller/owner decision.
- Read limitation (not a finding): repo-wide Actions run listing returned
  HTTP 404 for this token, so absence of installer runs is proven only at
  the three head SHAs via check-runs, which is the material scope.

## Before / after

- Before: 25-test focused file 14 pass / 11 fail; installer trigger
  `{local-worker/**, LICENSE, own file}`.
- After: 25/25 pass; 129/129 related gate/workflow suites pass; trigger
  mirrors `WORKER_PATH_PATTERNS` + own file; gate/CI semantics otherwise
  identical.
