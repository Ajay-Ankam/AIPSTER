# Worker demo integration — result

- Lane: `task-4/lanes/muse-worker-demo-integration-20261103`,
  branch `muse/worker-demo-integration-20261103`.
- Base: verified main `5b3fdb71f9cb1cfd16781fba0c9bddca8b309743`
  (`Merge pull request #99`, equals `remotes/origin/main` here).
- Worker source: reviewed preflight
  `0f2ca390d3153336816c96ded92e75d2955f6719` (rounds 1–3 PASS).
- Merge-base (preflight↔main): `a33898fcf1f840b27825a94b453a81ba3f2a77f4`.

## Ownership / collision check

- The 11 owned paths below are the worker-side PR86 delta; no other
  active lane owns them in this integration. Neighboring lanes
  (`muse/worker-runtime`, `muse/worker-delivery`,
  `muse/worker-integration`, `muse/bundle-qualification`,
  `muse/worker-admission`, `muse/worker-fabric-20261103`) were listed
  for awareness; none were edited and none block these paths.
- Untouched by design: `pairing.py`, `private_storage_win32.py`
  (PR62 ACL owner retains), installer/tray sources, vendor, CI,
  website files, enrollment, live data.

## Three-way file disposition (merge-base / main / preflight)

| File (under `local-worker/`) | Base | Main | Preflight | Action |
|---|---|---|---|---|
| `RUNTIME-PLAN.md` | — | — | new | added verbatim |
| `packaging/windows/delivery_check.py` | — | — | new | added verbatim |
| `packaging/windows/launcher.py` | Y | =base | +41/−part | preflight version applied; main unchanged since base, nothing to preserve |
| `packaging/windows/qualify.py` | Y | =base | +533/−67 | same as above |
| `packaging/windows/test_delivery_check.py` | — | — | new | added verbatim |
| `packaging/windows/test_launcher_runtime_plan.py` | — | — | new | added verbatim |
| `packaging/windows/test_preflight_qualification.py` | — | — | new | added verbatim |
| `packaging/windows/test_uninstall_observed.py` | — | — | new | added verbatim |
| `runtime_discovery.py` | — | — | new | added verbatim |
| `runtime_setup.py` | — | — | new | added verbatim |
| `test_runtime_setup_plan.py` | — | — | new | added verbatim |

`main` carries no changes to any of these 11 paths since the
merge-base (verified by empty `base→main` diffs), so applying the
reviewed preflight versions adds the delta with zero main-side
content to preserve and no unrelated main fix disturbed. Staged delta
is exactly these 11 files plus this report; nothing else in the tree
is staged or modified.

## Verification (pinned interpreter, offline, fake/temp fixtures)

`C:\Users\NM2\Documents\aipster-local-worker-f3e115e\AIPSTER\local-worker\.venv\Scripts\python.exe -B`
(3.12.14, pydantic 2.13.5), run from the lane root:

| Suite | Result |
|---|---|
| `local-worker/packaging/windows/test_delivery_check.py` | 36 tests OK |
| `local-worker/test_runtime_setup_plan.py` | 22 tests OK |
| `local-worker/packaging/windows/test_launcher_runtime_plan.py` | 7 tests OK |
| `local-worker/packaging/windows/test_preflight_qualification.py` | 10 tests OK |
| `local-worker/packaging/windows/test_uninstall_observed.py` | 35 tests OK (2 skipped) |

Total: 110 run, 108 pass, 2 environment skips (native symlink
rights absent; covered by the occupied-file O_EXCL test per the
in-test skip reasons). No installs, builds, engine/model downloads,
native services, or real generation. Runtime discovery exercised
observe-only via fakes; `runtime-plan` provisions nothing by design.

## What remains mock / unconfigured (unchanged semantics)

- `delivery-check: ready` = bundle/config validation only (honest
  loader-or-unknown rule from round 3); unknown whenever the worker
  loader cannot run. Not live-runtime, capability, or
  qualified-artifact proof.
- `runtime-plan: ready` = preflight only: engine observed on PATH or
  a configured path, GGUF magic bytes verified, placement evidence
  compatible. Binaries never executed; no model residency, identity
  attestation, or inference qualification. Mock config stays
  explicitly unqualified (`setup-required`).
- No device/GPU evidence added or claimed; CPU-only execution
  contract untouched.

## Native qualification limits

- Focused offline suites only (above); no full suite, no frozen
  binary built, no installer run, no tray install, no live host
  qualification. `qualify.py` native profiles were not executed here.
- Production workflow hold, #84 release hold, and unsigned-install
  approval remain in force. No enrollment changes. No publish, push,
  merge, or deploy; local commit for independent review only.
