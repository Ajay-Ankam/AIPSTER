# local-worker install changelog

## 2026-11-04 — Real setup path on all OS prompts; worker pin moves to 6af33d4

- Worker pin moves to `6af33d4a76765b47f9bed1a14c73d36e5aace592` (published
  main merge, PR-reviewed, hosted CI green): the only reviewed revision
  carrying the real-runner contract (`runtime_setup.py`, `runtime_discovery.py`,
  `model_identity.py`, `configs/cpu.toml`). It supersedes the mock-era
  `3fa309c` pin, which predates those files. The docs pin is the commit
  carrying this entry; worker and docs pins are compatible but not required
  to be equal.
- Website setup packets (Windows/macOS/Linux) now install and configure a
  REAL worker (resident engine + operator-provided model, planned with
  `runtime_setup.py --config config.toml`, served with `config.toml`).
  Mock serve is explicit demo/diagnostic opt-in only
  (`AIPSTER_WORKER_MOCK_DEMO=1` with `configs/mock.toml`); a self-test or a
  green connection is never a qualification claim.
- Packet honesty additions: reuse an already-running sender instead of a
  duplicate; usable=false is read literally and never relabeled; no fabric
  endpoint is configured (loopback is local-only, not a fabric route).
- README quickstart, Linux notes, and engine section now name the new pin
  (the engine section is renamed to "Real engine preparation (resident reuse
  preferred)" with a reuse-before-build pointer), so the linked docs no longer
  present the old `3fa309c` checkout as current. The update overlay moves the
  checkout and re-gates `pairing.py`, but additionally requires removing
  `.venv` and rerunning `install.py`: the vendored `dendrite` package changed
  between the pins and is installed non-editable, so a kept `.venv` would run
  the old code under the new checkout.
- Managed runtimes stay cold (`resident` false) until an explicit
  user-approved `POST /v1/models/load`; attach mode must show resident true.
  Existing mock-era installs migrate with identity kept: stop the old sender
  in its own terminal, restart one sender on the real `config.toml`, never
  kill or duplicate it.
- Status: real setup is unqualified natively on every OS. Windows x64 mock
  remains the only tested installation. Screenshot evidence (paired node
  with heartbeat OK, usable=False, simulated engine, no fabric address;
  host unconfirmed) confirms a green connection is reachability only.

## 2026-11-04 — Linux notes (unqualified adaptation)

- Added `README.md` "Linux notes (unqualified adaptation)": x64 bash
  sequence mirroring the generated prompt's Linux variants, deliberate pins,
  expected mock fields (`simulated: true`, `usable: false`), and the
  reachability-only meaning of setup/pairing/heartbeat/status.
- Website setup prompt: Linux targets now get an early READ FIRST block with
  the same statements (source revision, pins deliberate not latest,
  unqualified adaptation, no real-execution claim, fixed step sequence).
- Pins unchanged: worker source `3fa309cb08461ea046ee23e801404911c1f3bcc2`,
  uv 0.12.12, Python 3.12.14.
- Status: Windows x64 mock check remains the only tested installation. The
  Linux flow was worked through once as an assisted install; the VM
  connection is user-reported and pending independent readback. No native
  Linux test run is claimed, and no failure log exists in this record.
