# AIPSTER Worker (Windows tray): install/run instructions

Lane: GOOSE-WINDOWS-TRAY-DELIVERY-20261102 (Muse). Source `cd5c2ef`.
Status: NO qualified artifact exists yet for this source — no install is
possible from these instructions until the artifact below exists. Nothing here
is executed; JJP install additionally requires the rollout procedure in
`STATUS-AND-ROLLOUT-20261102.md` and exact approval.

## 1. Obtain the artifact (gating precondition)

- Source: rebuilt from the reviewed merge commit (current lane `cd5c2ef`;
  release owner re-verifies at build time), re-qualified, SHA-256 recorded.
- At lane close: local heavy build NOT admitted (commit-free 18,952 MB <
  24 GB gate, re-measured 2026-11-02); no `worker-installer-build.yml` run
  exists on `main` — recent successes are PR-branch review builds
  (`ds/inference-integration-20261101 @5bf623c` run 41363198300,
  `muse/worker-connect-followup @235733d` run 41224722515), neither built
  from current source.
- CI artifact inspection (2026-11-02, read-only API): both successful runs
  expose ONLY `windows-installer-screenshots` (~360 KB, unexpired) — no
  Setup exe, no `manifest.json`, no `SHA256SUMS` is uploaded by the
  workflow. There is no downloadable installer artifact in CI, current or
  stale. No artifact was downloaded (the inference-branch run is out-of-lane
  scope); no workflow dispatch was triggered (not authorized).
- Concrete unblock paths (both approval-gated): (a) local rebuild when
  commit-free clears ≥24,000 MB with a coordinator-granted heavy slot;
  (b) authorized `worker-installer-build.yml` dispatch or release-owner
  rebuild + re-qualify from the merge commit, then wire that exact verified
  artifact.
- Trust path only: download from the AIPSTER GitHub release page and verify
  the SHA-256 against `SHA256SUMS` / the dashboard checksum. Builds are
  **unsigned**: Windows SmartScreen shows "Unknown publisher". Do not disable
  OS security features.

## 2. Install (attended)

1. Close any running AIPSTER worker first (the installer aborts, exit 2
   silent, over `aipster-tray.exe` / `aipster-worker.exe` / `dendrite.exe`).
2. Run the Setup exe for your user account only (no elevation, no service,
   driver, or firewall rule).
3. Wizard: confirm the install location (must be the stable destination, not
   a Temp directory), accept the license, leave "Start when I log in" OFF
   unless explicitly wanted (per-user login entry, not a system service).
4. Finish page: "Start AIPSTER Worker now" is unchecked by default — check it
   only to launch immediately.

## 3. Run (tray-first)

- Launch from the Start Menu or desktop shortcut (`AIPSTER Worker`); both
  target `aipster-tray.exe`, never the bare daemon. The tray icon appears in
  the notification area (Windows 11 may hide it in the overflow flyout).
- First run creates `%LOCALAPPDATA%\AIPSTER-Worker` (`config.toml`,
  `api-token.txt`, `state/`, `logs/`) and serves simulated (mock) compute on
  `127.0.0.1:8090`. Nothing is shared, paired, or contributed.
- Right-click the icon: status lines, Pair (opens the console prompt — type
  the dashboard code there, never into the tray), Connect, Start/Stop,
  Settings (`config.toml`), Copy endpoint address (host:port only, never
  tokens), logs, Quit. A second launch reuses the running instance (status
  balloon, no duplicate worker).
- A heartbeat proves reachability only, never inference readiness.

## 4. Remove

- Uninstall removes the app, shortcuts, and registry; the data directory is
  preserved by default. Check "Also remove my worker data" (or
  `/REMOVEDATA=1`) only to delete it. A custom `AIPSTER_WORKER_DATA` folder
  is never touched.
- Token rotation: delete `api-token.txt` and restart (approval-gated on
  shared machines).
