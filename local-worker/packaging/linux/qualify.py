"""Qualify the Ubuntu AIPSTER Worker without touching the system.

Two profiles, mirroring packaging/windows/qualify.py:

- full (default): unit tests + DEB artifact validation from
  packaging/linux/dist/ (control fields, payload inventory, maintainer
  scripts, desktop entry, icon set). Refuses when a live tray owns the
  default data dir, so qualification never races a running worker.
- --app-dir <frozen app>: coexistence profile, behavior-only. Exercises
  the frozen bundle (console + tray CLIs, sender entry, delivery-check)
  using dynamic ports and temp data dirs, so a live worker keeps 8090.

Nothing here installs, uploads, or modifies system state: no dpkg
install, no root, no services. Installing the DEB is the reviewer's
independent step (see UBUNTU-DESKTOP-HANDOFF.md).
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGING = HERE.parent
ROOT = PACKAGING.parent
sys.path.insert(0, str(ROOT / "vendor/eif"))
sys.path.insert(0, str(PACKAGING))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))


def fail(message):
    print(f"QUALIFY FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f": {detail}" if detail and not ok else ""), flush=True)
    if not ok:
        fail(name)


def default_data_dir():
    override = os.environ.get("AIPSTER_WORKER_DATA")
    if override:
        return Path(override)
    from pairing import default_data_dir as pairing_default
    return pairing_default()


def run_unit_tests():
    loader = unittest.TestLoader()
    suite = loader.discover(str(HERE), pattern="test_linux_packaging.py")
    stream = io.StringIO()
    runner = unittest.TextTestRunner(stream=stream, verbosity=1)
    result = runner.run(suite)
    print(stream.getvalue())
    check("unit tests", result.wasSuccessful(),
          f"errors={len(result.errors)} failures={len(result.failures)} "
          f"ran={result.testsRun}")
    return result.testsRun


def validate_deb(dist_dir):
    deb = sorted(dist_dir.glob("aipster-worker_*_amd64.deb"))
    check("deb artifact present", len(deb) == 1, f"found={len(deb)}")
    deb = deb[0]
    manifest_path = dist_dir / "manifest.json"
    check("manifest present", manifest_path.is_file())
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    check("manifest artifact hash matches",
          manifest.get("artifact_sha256") == _sha256(deb),
          "manifest.json disagrees with the .deb on disk")
    check("manifest payload non-empty", manifest.get("payload_files", 0) > 20)
    with tempfile.TemporaryDirectory(prefix="aipster-deb-list-") as temp:
        proc = subprocess.run(["dpkg-deb", "--contents", str(deb)],
                              capture_output=True, text=True)
        check("dpkg-deb lists contents", proc.returncode == 0, proc.stderr[-300:])
        contents = proc.stdout
        for required in ("usr/bin/aipster-tray", "usr/bin/aipster-worker",
                         "usr/bin/aipster-dendrite",
                         "usr/share/applications/aipster-worker.desktop",
                         "usr/share/doc/aipster-worker/copyright"):
            check(f"deb contains {required}", f"./{required}" in contents, required)
        # Control metadata lives outside the data tar; verify it directly.
        for deb_field, want in (("Package", "aipster-worker"),
                                ("Architecture", "amd64")):
            field_proc = subprocess.run(
                ["dpkg-deb", "--field", str(deb), deb_field],
                capture_output=True, text=True)
            check(f"control {deb_field}={want}",
                  field_proc.returncode == 0 and field_proc.stdout.strip() == want,
                  field_proc.stdout.strip()[-200:])
        check("deb installs no autostart file (opt-in only, default off)",
              "autostart" not in contents.lower(),
              "no autostart file may ship active or inactive")
        check("deb touches no home dir", "/home/" not in contents and "/root/" not in contents)
        info = subprocess.run(["dpkg-deb", "--info", str(deb)], capture_output=True, text=True)
        for field in ("Package: aipster-worker", "Architecture: amd64", "Maintainer:"):
            check(f"control has {field}", field in info.stdout, field)
    return manifest


def _sha256(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def qualify_app_dir(app_dir):
    """Coexistence profile: frozen-bundle behavior, zero install touch."""
    app_dir = Path(app_dir)
    for exe in ("aipster-tray", "aipster-worker", "aipster-dendrite"):
        check(f"frozen {exe} present", (app_dir / exe).is_file())
    scrubbed = {"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/root")}
    with tempfile.TemporaryDirectory(prefix="aipster-qual-") as temp:
        temp = Path(temp)
        env = dict(scrubbed)
        env["AIPSTER_WORKER_DATA"] = str(temp / "data")
        tray = str(app_dir / "aipster-tray")
        worker = str(app_dir / "aipster-worker")
        proc = subprocess.run([tray, "status"], capture_output=True, text=True, env=env,
                              timeout=60)
        check("tray status without state exits 2", proc.returncode == 2, proc.stderr[-200:])
        proc = subprocess.run([worker, "--version"], capture_output=True, text=True, env=env,
                              timeout=60)
        check("launcher --version", proc.returncode == 0 and bool(proc.stdout.strip()))
        proc = subprocess.run([worker, "sender", "--once", "--data-dir", str(temp / "sender")],
                              capture_output=True, text=True, env=env, timeout=60)
        check("sender without pairing exits 2 (NOT_PAIRED)",
              proc.returncode == 2 and "not paired" in proc.stderr, proc.stderr[-200:])
        data = temp / "data"
        data.mkdir(parents=True)
        (data / "config.toml").write_text(
            (HERE / "default.toml").read_text(encoding="utf-8"), encoding="utf-8")
        proc = subprocess.run([worker, "delivery-check", "--app-dir", str(app_dir),
                               "--data-dir", str(data)],
                              capture_output=True, text=True, env=env, timeout=60)
        check("delivery-check blocks mock-only store",
              proc.returncode == 2 and "blocked" in proc.stdout, proc.stdout[-300:])
        # Headless tray serve + IPC roundtrip on an ephemeral port config.
        port = _free_port()
        (data / "config.toml").write_text(
            (HERE / "default.toml").read_text(encoding="utf-8").replace("port = 8090",
                                                                        f"port = {port}"),
            encoding="utf-8")
        env["AIPSTER_WORKER_MOCK_DEMO"] = "1"
        server = subprocess.Popen([tray, "run", "--headless"], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            from aipster_tray import ipc_linux
            live = _wait_until(lambda: ipc_linux.running(data), timeout=30)
            check("headless tray comes up live", live)
            if live:
                # The command socket binds before prepare() writes state:
                # wait for the state file, not just the socket.
                from aipster_tray import state as tray_state
                ready = _wait_until(
                    lambda: tray_state.read_state(data / "state.json") is not None,
                    timeout=30)
                check("tray publishes state", ready)
                # In-process CLI calls read the data dir from this process's
                # environment (unlike the subprocess above, which got env=).
                saved = dict(os.environ)
                os.environ["AIPSTER_WORKER_DATA"] = str(data)
                try:
                    out = io.StringIO()
                    sys.path.insert(0, str(HERE))
                    import tray_main
                    with redirect_stdout(out):
                        rc = tray_main.main(["status"])
                    check("live status reports (live)",
                          rc == 0 and "(live)" in out.getvalue(),
                          out.getvalue()[-200:])
                    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                        rc = tray_main.main(["quit"])
                    check("quit delivered", rc == 0)
                finally:
                    os.environ.clear()
                    os.environ.update(saved)
            server.wait(timeout=30)
            check("tray exits 0 on quit", server.returncode == 0,
                  f"rc={server.returncode}")
        finally:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=10)


def _free_port():
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _wait_until(predicate, timeout=30):
    import time as _t
    deadline = _t.monotonic() + timeout
    while _t.monotonic() < deadline:
        try:
            if predicate():
                return True
        except OSError:
            pass
        _t.sleep(0.5)
    return False


def validate_desktop_entry():
    desktop = HERE / "desktop/aipster-worker.desktop"
    validator = shutil.which("desktop-file-validate")
    if validator is None:
        print("[SKIP] desktop-file-validate not installed; parsed fields only", flush=True)
        text = desktop.read_text(encoding="utf-8")
        check("desktop entry has Exec+Icon", "Exec=/usr/bin/aipster-tray" in text
              and "Icon=aipster-worker" in text)
        return
    proc = subprocess.run([validator, str(desktop)], capture_output=True, text=True)
    check("desktop-file-validate clean", proc.returncode == 0,
          (proc.stdout + proc.stderr)[-500:])


def main(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    app_dir = None
    if "--app-dir" in args:
        app_dir = args[args.index("--app-dir") + 1]
    if app_dir:
        print("profile: coexistence (behavior-only, no install touch)", flush=True)
        qualify_app_dir(app_dir)
        validate_desktop_entry()
        print("QUALIFY OK (coexistence)", flush=True)
        return 0
    print("profile: full (unit tests + dist artifact validation)", flush=True)
    if os.environ.get("AIPSTER_WORKER_DATA"):
        print("note: AIPSTER_WORKER_DATA is set; live-tray check uses it", flush=True)
    try:
        from aipster_tray import ipc_linux
        if ipc_linux.running(default_data_dir()):
            fail("a live tray owns the default data dir; quit it first "
                 "(`aipster-tray quit`) so qualification never races a running worker")
    except ImportError:
        pass
    ran = run_unit_tests()
    print(f"unit tests ran: {ran}", flush=True)
    dist_dir = HERE / "dist"
    if any(dist_dir.glob("aipster-worker_*_amd64.deb")):
        validate_deb(dist_dir)
    else:
        print("[SKIP] no DEB in dist/ (run build.py first); unit tests only", flush=True)
    validate_desktop_entry()
    print("QUALIFY OK (full)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
