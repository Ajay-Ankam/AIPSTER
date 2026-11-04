# Ubuntu Desktop Handoff — AIPSTER Worker (native Linux)

## Candidate

- Base: `0de5103b078a223546ab422ef16a73436ea39cdb` (upstream `main`)
- Branch: `muse/ubuntu-desktop-20261104` (sole writer; isolated checkout)
- Candidate code commit: `55919ede842113abea8fd5272c3aeb51ab1dbad4`
  (probe-vs-acquire race fix; this handoff ships in a follow-up commit
  on the same branch; supersedes `9e3be30`)

## Scope delivered

Local-worker Linux launcher + desktop/tray UI analogous to the Windows
program, Ubuntu DEB packaging, start/stop/status/settings, existing
account-pairing integration (same protocol/store, outbound sender only),
desktop entry + icons, safe uninstall preserving user data. No push,
merge, deploy, system-wide install, or root/package-manager operations
were performed. The dev box's paired sender unit
(`aipster-ubuntu-heartbeat.service`, shared data dir) was never touched;
a probe-created `tray.lock` in the shared dir was removed again.

### New files

- `local-worker/packaging/aipster_tray/ipc_linux.py` — fcntl lock +
  Unix-socket command IPC (`ensure|stop|start|restart|quit`); probes never
  create files in foreign data dirs.
- `local-worker/packaging/aipster_tray/backend_linux.py` — Tk status
  window (stdlib only, guaranteed fallback) + best-effort indicator
  (Ayatana/Gtk when typelibs exist) + guarded xdg-open/terminal/clipboard.
- `local-worker/packaging/linux/` — `launcher.py` (`aipster-worker`:
  run/inspect/tray/pair/sender/delivery-check/runtime-plan/autostart),
  `tray_main.py` + `tray_entry.py` (`aipster-tray`), `dendrite_linux.spec`,
  `build.py`, `qualify.py`, `test_linux_packaging.py` (44 tests),
  `default.toml`, `desktop/aipster-worker.desktop`, `icons/hicolor/…`
  (stdlib-rendered PNGs), `deb/{control,postinst,prerm,postrm,copyright,
  README.Debian}`, `installer-build.{in,lock}` (hash-pinned PyInstaller).

### Shared files touched (Windows behavior preserved)

- `aipster_tray/firstrun.py` — `data_dir()` POSIX branch delegates to
  `pairing.default_data_dir()` (same store as `pairing.py pair`); `nt`
  branch byte-identical.
- `aipster_tray/controller.py` — `child_env()` POSIX branch (minimal
  PATH/HOME/LANG + token); `pair_target()` picks the Linux launcher off
  Windows. `nt` branches byte-identical.
- `aipster_tray/child.py` — `sender_argv`/`dendrite_exe` POSIX names
  (`aipster-dendrite`; see below). `nt` branch byte-identical.
- `packaging/windows/delivery_check.py` — platform-constant executable
  names only (`nt` tuple unchanged).
- `local-worker/.gitignore` — ignore `packaging/linux/{build,dist}/`
  (mirrors the Windows entries).

Two Linux-only facts the reviewer must know:

1. The frozen raw CLI is named **`aipster-dendrite`**, not `dendrite`: a
   frozen exe named `dendrite` shadows the bundled `dendrite/` package
   directory (PyInstaller's path hook refuses paths that are existing
   files), breaking every `dendrite.*` submodule import. The `.exe`
   suffix saves Windows from the same collision. `/usr/bin` ships
   `aipster-worker`, `aipster-tray`, `aipster-dendrite` as wrappers that
   set `LD_LIBRARY_PATH` to the app dir (frozen exes carry no RUNPATH,
   so the bundled Tcl/Tk 9 libs resolve deterministically).
2. First-run/autostart semantics mirror Windows: nothing starts on login
   by default (`aipster-worker autostart on|off|status` manages
   `~/.config/autostart/`); uninstall/purge never touches
   `~/.local/share/aipster-worker` (documented manual removal).

## Reproducible artifact

- `local-worker/packaging/linux/dist/aipster-worker_0.1.0-1_amd64.deb`
  (22,018,310 bytes)
- `sha256 d8a4e5cc46e1bf966b1d0f09ae39ae80b1949c68a6bbae49ed0271f6b2de2830`
- `manifest.json` + `SHA256SUMS` alongside; locks:
  `requirements.lock`, `build-requirements.lock`,
  `packaging/linux/installer-build.lock`; CPython 3.12.14 via uv,
  PyInstaller 6.22.3, `SOURCE_DATE_EPOCH=1793750400`.
- Rebuild: `cd local-worker && SOURCE_DATE_EPOCH=1793750400 python3
  packaging/linux/build.py` (needs `uv`, `dpkg-deb`, PyPI network;
  writes only `packaging/linux/{build,dist}/`, ignored by git).

## Evidence

- Unit suite `packaging/linux/test_linux_packaging.py`: **44 tests OK**
  (system python run; 3 skipped: 2 Tk tests need a display, 1 needs the
  worker dependency closure). Of the 42, the bring-up cycle test was
  later run focused with the build venv: OK.
- Tk backend tests under isolated Xvfb (`xvfb-run`, not the user
  desktop): **7/7 OK**, all 5 states rendered, buttons drive
  start/quit, honesty gate over every label.
- Build step 4 (build venv, hash-locked installs): **44 tests OK
  (skipped=2, the display tests)**.
- Build step 7 (frozen, scrubbed env): `--help`, mock `inspect`
  (simulated), tray `--help`/`status`, sender `--once` NOT_PAIRED,
  delivery-check blocking mock store — all OK; **frozen Tk window
  fallback under Xvfb: OK** (attach logged, quit clean, exit 0).
- `qualify.py` full profile: **QUALIFY OK** (unit + DEB inventory,
  control fields, no autostart/Home payload, `desktop-file-validate`
  clean). Coexistence profile (`--app-dir`, frozen bundle, ephemeral
  port, temp data): **QUALIFY OK** (live status, quit, exit 0).
- Reviewer note: an independent harness is already exercising the
  extracted DEB (start/stop from payload); that is the install/runtime
  proof, not a rebuild of this evidence.

## Limitations / not proven here

- Pairing end-to-end needs a real one-time code (dashboard My Compute);
  sender-without-pairing reports NOT_PAIRED (exit 2) by design. No mock
  heartbeat was ever sent; nothing claims inference readiness.
- Indicator backend: no Ayatana/Gtk typelibs on this host, so the Tk
  window is the proven path; frozen `gi` is absent (system-only), so the
  frozen bundle always uses Tk. Source runs with typelibs can use the
  indicator path (untested here).
- `Depends: libgcc-s1, zlib1g` (computed from `ldd`); an X stack is
  assumed from the Ubuntu desktop target.
- DEB is unsigned (same standing note as the Windows build); verify via
  `SHA256SUMS`. No autostart shipped; purge preserves user data.

## Reviewer verification commands (no root, no shared state)

```sh
cd /tmp && rm -rf aipster-verify && mkdir -p aipster-verify && cd aipster-verify
dpkg-deb --info <checkout>/local-worker/packaging/linux/dist/*.deb
dpkg-deb -x <checkout>/local-worker/packaging/linux/dist/*.deb payload
sha256sum -c <checkout>/local-worker/packaging/linux/dist/SHA256SUMS --ignore-missing
export LD_LIBRARY_PATH=$PWD/payload/usr/lib/aipster-worker/app
export AIPSTER_WORKER_DATA=$PWD/data
$PWD/payload/usr/lib/aipster-worker/app/aipster-tray status      # expect exit 2, "never run"
$PWD/payload/usr/lib/aipster-worker/app/aipster-worker delivery-check \
  --app-dir $PWD/payload/usr/lib/aipster-worker/app --data-dir $PWD/data
xvfb-run -a $PWD/payload/usr/lib/aipster-worker/app/aipster-tray &  # window smoke
$PWD/payload/usr/lib/aipster-worker/app/aipster-tray status         # live, unpaired overlay
$PWD/payload/usr/lib/aipster-worker/app/aipster-tray quit
desktop-file-validate <checkout>/local-worker/packaging/linux/desktop/aipster-worker.desktop
```

Use an ephemeral port for serving: copy `default.toml` into the temp
data dir and replace `port = 8090` before `run`. Never point
`AIPSTER_WORKER_DATA` at `~/.local/share/aipster-worker` and never start
a second sender there (the production heartbeat unit owns that lock).

## Incident log (root cause found and fixed)

- `test_full_run_cycle_headless` failed once in a full-suite run
  ("tray did not come up"; the tray thread reported the lock held on
  a fresh temp dir). Root cause, demonstrated deterministically: the
  main thread's `running()` liveness probe takes `LOCK_EX` for
  microseconds, and `SingleInstance.acquire()` treated any contention
  as a live owner — an acquire landing exactly in a probe window waited
  10s for a server that never comes. A barrier test pinning a 100ms
  exclusive hold failed on the old code (acquire → False, no server)
  and the mechanism matches the observed signature exactly.
- Fix (`aipster_tray/ipc_linux.py`): `acquire()` retries contention for
  a bounded 0.5s window (20ms sleeps); transient probe holds clear in
  far less, a genuine owner holds for the tray's lifetime. Mutual
  exclusion is unchanged — success still requires actually holding the
  lock, and a held lock still reports False. New maintained tests:
  `test_acquire_tolerates_transient_exclusive_hold` (red before, green
  after) and `test_acquire_still_reports_live_owner` (bounded False).
  Verified: IPC class 8/8, incident test focused green, 15/15 repeated
  bring-up cycles green, rebuild suite 44 tests OK, frozen Xvfb window
  smoke OK. The bring-up timeout now also reports lock/socket/thread
  facts if it ever recurs.
- Shared-dir `tray.lock` planted by an early creating probe: removed
  (0 bytes, unheld); probes are now non-creating (`r+b`).

## Installed verification (coordinator, system install)

- Coordinator installed this exact artifact with `sudo dpkg -i` at
  18:13:55Z: install ok, version 0.1.0-1, SHA256 `d8a4e5cc…2de2830`
  as above.
- Installed `/usr/bin/aipster-tray` verified under an isolated Xvfb
  with temp data: native window attached, mock worker healthz ok, live
  status running, quit delivered rc 0 and launcher exit 0 at 18:14Z.
- Existing heartbeat unit unchanged: MainPID 1536738 active,
  NRestarts 0; production pairing/sender state untouched.
- Real inference remains unproven by design: the bundled engine is
  simulated, `/api/jobs` stays disabled, and heartbeats prove
  reachability only — never inference readiness.

## Verdict: READY-for-demo (installed verification completed)

No known blockers. The earlier intermittent bring-up timeout is
resolved (root cause + fix in the incident log above); no open
product questions remain from this work.
