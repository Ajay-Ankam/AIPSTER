# Windows tray delivery: status corrections + revised JJP rollout procedure

Owner: GOOSE-WINDOWS-TRAY-DELIVERY-20261102 (Muse). Source `974a345`, clean tree unless noted.
Live worker, sender chain, enrollment `r_9c27cd5f`, port 8090: untouched. Nothing below is executed.

## 1. Status honesty corrections (GOOSE-TRAY-EVIDENCE-CORRECTION)

- M2 rebuilt installer: NOT EXECUTED. Heavy-blocked (commit-free ~20.3 GB < 24 GB gate).
  Source inspection (spec/NSI/build.py/icons/licenses) is not qualification.
  Exact unbuildable artifact: `AIPSTER-Worker-0.1.0-win64-setup.exe`
  (worker 0.1.0, installer build 1) from source `974a345`.
- M4 old/new-package fixture verification: NOT EXECUTED (needs frozen old+new
  packages = heavy-blocked). NSI text + qualify full-profile reads are design
  evidence only, not upgrade/rollback qualification.
- `test_packaging.py` `PackagingTests` (20 tests) rerun under the pinned venv:
  20/20 PASS, including both token-reload tests. Bare-interpreter 72/74 stands
  superseded for this class and is never counted as all-passing.
- Pinned interpreter identified (read-only, no installs, no tree changes):
  `C:/Users/NM2/Documents/aipster-local-worker-f3e115e/AIPSTER/local-worker/.venv/Scripts/python.exe`
  CPython 3.12.14, pydantic 2.13.5, pydantic-core 2.46.5 — matches pinned
  CPython 3.12.14 and `requirements.lock` pins exactly. Caveat: this venv is
  co-located with the live source install; use is execute-only from this
  worktree (cwd here, test sys.path prefers this tree's `vendor/eif`), no
  writes, no signals to live processes. Targeted rerun completed on coordinator
  slot signal: 20/20 PASS (commit-free 19,559 MB pre / 17,868 MB post).

## 2. Revised JJP rollout procedure (approval-gated; NONE executed)

Precondition: a qualified published artifact (rebuilt from merge commit,
re-qualified, SHA256 wired) exists. The Temp screenshot payload is never a
rollback source: it is unqualified, superseded, and has the wrong entrypoint.

1. Verify destination, and never trust `/D=` alone. The registered
   `HKCU\Software\AIPSTER-Worker\InstallDir` is the Temp screenshot directory
   (`...\Temp\aipster-shots-lk3ep8fo\app`), and `worker.nsi .onInit` reuses it
   whenever the flag value equals the NSIS default — an explicit `/D=` set to
   the default is indistinguishable from none (reviewer proved A/B). So,
   approval-gated, do one of: (a) clear/replace the stale `InstallDir` value
   before installing; (b) install attended and verify the Directory page
   shows the stable destination (`$LOCALAPPDATA\Programs\AIPSTER-Worker`,
   currently absent: verified); or (c) install to a distinct verified
   destination. Pre-flight abort: if the resolved install dir is not the
   expected stable one, stop before any file write.
2. Take a bounded secret-free pre-change snapshot (owner-held, outside every
   repo, never `api-token.txt`): file copies of the reconciled `config.toml`,
   `pairing.json`, and worker `state` file, recorded by name/size/SHA-256 in
   the rollout receipt with token material excluded by construction. This
   complements installer preservation rather than replacing it: it guards the
   F1 wrong-directory case, where the installer preserves the right data only
   if it actually targets the right directory. Copies are destroyed after the
   retention window Peter sets.
3. Reconcile identity read-only (approval-gated inspection, no changes):
   enumerate actual data dirs (default `%LOCALAPPDATA%\AIPSTER-Worker` if
   present; honored `AIPSTER_WORKER_DATA` if set — never guessed), confirm
   which holds `pairing.json` for enrollment `r_9c27cd5f`, and record the
   old uninstall-registration values before touching them.
4. Reconcile the existing sender before stopping anything: the `pairing.py`
   loop under `Documents\aipster-local-worker-f3e115e` is a separate heartbeat
   chain, not a tray child. Decide (Peter) which sender survives cutover; the
   new tray recognizes an external sender (`already running in another
   process`, no duplicate beats) but overlapping loops must end by decision,
   not by kill sweep.
5. Stop the old worker through its own approved stop path (the old payload has
   NO `aipster-tray.exe`, so no old-tray-Quit exists; `taskkill` and
   unknown-process stops are forbidden). The installer then runs: it refuses
   over any still-running worker (exit 2 silent), which is the expected
   conflict signal, not a failure to override.
6. Install, then post-check before declaring success: registry `InstallDir`,
   uninstall `InstallLocation`, and both shortcuts resolve to
   `<dest>\aipster-tray.exe` (never Temp); data dir contents (config, token,
   pairing, state, logs) intact against the step-2 snapshot names/hashes.
   Then start the tray from the shortcut and verify icon, healthy state, and
   pairing overlay; installer refusal (exit 2) at any point stops the run.
7. Credentials and rollback honesty: no blanket backup, no token material in
   evidence/logs/backups. Preservation rides the installer's default (data
   dir untouched; `/REMOVEDATA` never passed), with the step-2 snapshot as
   the backstop. If token compromise is suspected, rotate via the supported
   path (delete `api-token.txt`, restart) after approval. With no qualified
   prior installer, rollback is uninstall (data preserved by default) back to
   a clean uninstalled state — NOT reinstalling the Temp payload. A
   prior-version rollback becomes possible only once a qualified prior
   artifact exists.
