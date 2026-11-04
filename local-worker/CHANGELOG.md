# local-worker install changelog

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
