"""Linux packaging regressions. No installer, tray daemon, or inference runs.

Tk window tests need a display and skip without one; qualify.py runs this
file under xvfb-run so they are exercised on a headless host. Everything
else runs anywhere with the standard library.
"""

import fcntl
import importlib.util
import io
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

LINUX = Path(__file__).resolve().parent
WINDOWS = LINUX.parent / "windows"
ROOT = LINUX.parent.parent
PACKAGING = LINUX.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "vendor/eif"))
sys.path.insert(0, str(PACKAGING))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(LINUX))

import pairing  # noqa: E402
from aipster_tray import child, controller, firstrun as first, state  # noqa: E402
from aipster_tray import ipc_linux  # noqa: E402
from aipster_tray.backend_headless import HeadlessBackend  # noqa: E402
from aipster_tray import backend_linux  # noqa: E402
import tray_main  # noqa: E402

launcher_spec = importlib.util.spec_from_file_location("linux_launcher", LINUX / "launcher.py")
launcher = importlib.util.module_from_spec(launcher_spec)
launcher_spec.loader.exec_module(launcher)
delivery_spec = importlib.util.spec_from_file_location(
    "windows_delivery_check", WINDOWS / "delivery_check.py")
delivery = importlib.util.module_from_spec(delivery_spec)
delivery_spec.loader.exec_module(delivery)
build_spec = importlib.util.spec_from_file_location("linux_build", LINUX / "build.py")
build = importlib.util.module_from_spec(build_spec)
build_spec.loader.exec_module(build)


def run_main(func, argv, env_extra=None):
    """Run a CLI main with an isolated data dir. Returns (rc, out, err)."""
    with tempfile.TemporaryDirectory(prefix="aipster-linux-test-") as temp:
        env = {"AIPSTER_WORKER_DATA": temp}
        env.update(env_extra or {})
        with patch.dict(os.environ, env, clear=False):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                rc = func(argv)
    return rc, out.getvalue(), err.getvalue()


class FakeBackend(HeadlessBackend):
    def __init__(self, log):
        super().__init__(log)
        self.shown = 0

    def show(self):
        self.shown += 1


class FakeController:
    """Minimal controller surface used by IPC dispatch and window rendering."""

    def __init__(self, data):
        self.data = Path(data)
        self.state = state.STOPPED
        self.detail = ""
        self.loaded = None
        self.pairing = None
        self.backend = None
        self.actions = []
        self.log_lines = []
        self.running = True

    def log(self, message):
        self.log_lines.append(message)

    def endpoint_label(self):
        if not self.loaded:
            return ""
        node = self.loaded.node
        host = f"[{node.host}]" if ":" in str(node.host) else node.host
        return f"http://{host}:{node.port}"

    def menu_action(self, action):
        self.actions.append(action)

    def start_worker(self, manual=True):
        self.actions.append("start")
        return True

    def stop_worker(self):
        self.actions.append("stop")
        return True

    def restart_worker(self):
        self.actions.append("restart")
        return True

    def request_quit(self):
        self.actions.append("quit")
        self.running = False


class DataDirTests(unittest.TestCase):
    def test_posix_data_dir_matches_pairing_default(self):
        with patch.dict(os.environ, {}, clear=True):
            # Neither override may be set; HOME fallback keeps Path.home() working.
            os.environ.pop("AIPSTER_WORKER_DATA", None)
            got = first.data_dir()
        self.assertEqual(got, pairing.default_data_dir())

    def test_override_wins(self):
        with tempfile.TemporaryDirectory(prefix="aipster-dd-") as temp:
            with patch.dict(os.environ, {"AIPSTER_WORKER_DATA": temp}):
                self.assertEqual(first.data_dir(), Path(temp))

    def test_posix_store_is_private(self):
        with tempfile.TemporaryDirectory(prefix="aipster-dd-") as temp:
            data = Path(temp) / "worker-data"
            with patch.dict(os.environ, {"AIPSTER_WORKER_DATA": str(data)}):
                config, fresh = first.ensure_setup(first.data_dir())
            self.assertTrue(fresh)
            self.assertTrue(config.is_file())
            mode = stat.S_IMODE(data.stat().st_mode)
            self.assertEqual(mode, 0o700, oct(mode))


class ChildEnvTests(unittest.TestCase):
    def test_posix_env_is_minimal_and_carries_token(self):
        ctl = controller.Controller(Path("/tmp/does-not-matter"), HeadlessBackend(lambda m: None))
        ctl.token_env = "DENDRITE_API_TOKEN"
        ctl.token_value = "synthetic-token-value"
        with patch.dict(os.environ, {"PATH": "/usr/bin:/bin", "HOME": "/home/tester",
                                     "SECRET_SHOULD_NOT_PASS": "x"}, clear=True):
            env = ctl.child_env()
        self.assertEqual(env["DENDRITE_API_TOKEN"], "synthetic-token-value")
        self.assertIn("PATH", env)
        self.assertEqual(env["HOME"], "/home/tester")
        self.assertNotIn("SYSTEMROOT", env)
        self.assertNotIn("SECRET_SHOULD_NOT_PASS", env)

    def test_sender_argv_uses_linux_launcher_in_source(self):
        argv = child.sender_argv("/nonexistent-bundle", "/tmp/data-dir")
        self.assertEqual(argv[1:], [str(LINUX / "launcher.py"), "sender",
                                   "--data-dir", "/tmp/data-dir"])

    def test_pair_target_uses_linux_launcher_in_source(self):
        ctl = controller.Controller(Path("/tmp/does-not-matter"), HeadlessBackend(lambda m: None))
        with patch("aipster_tray.firstrun.bundle_dir", return_value=Path("/nonexistent")):
            exe, args = ctl.pair_target()
        self.assertEqual(args, [str(LINUX / "launcher.py"), "pair"])


class IpcLinuxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aipster-ipc-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "worker-data"
        self.data.mkdir()

    def test_lock_is_exclusive(self):
        first_guard = ipc_linux.SingleInstance(self.data)
        self.assertTrue(first_guard.acquire())
        second_guard = ipc_linux.SingleInstance(self.data)
        self.assertFalse(second_guard.acquire())
        first_guard.release()
        third_guard = ipc_linux.SingleInstance(self.data)
        self.assertTrue(third_guard.acquire())
        third_guard.release()

    def test_command_roundtrip(self):
        server = ipc_linux.CommandServer(self.data)
        server.start()
        try:
            seen = []
            stop = threading.Event()

            def pump():
                while not stop.is_set():
                    server.poll(seen.append, lambda m: None)
                    time.sleep(0.05)

            thread = threading.Thread(target=pump)
            thread.start()
            try:
                delivered, reply = ipc_linux.send_command(self.data, "start", timeout=10)
            finally:
                stop.set()
                thread.join(timeout=10)
            self.assertTrue(delivered)
            self.assertEqual(reply, "ok")
            self.assertEqual(seen, ["start"])
        finally:
            server.stop()

    def test_unknown_command_is_rejected(self):
        with self.assertRaises(ValueError):
            ipc_linux.send_command(self.data, "format-the-disk")

    def test_stale_socket_is_reclaimed(self):
        server = ipc_linux.CommandServer(self.data)
        server.start()
        server.sock.close()  # simulate a crashed owner: socket file stays, nobody listens
        server.sock = None
        replacement = ipc_linux.CommandServer(self.data)
        replacement.start()  # must unlink the stale socket and bind
        replacement.stop()

    def test_probe_creates_nothing(self):
        # Read-only probes must never plant files in a directory they do
        # not own (e.g. a production data dir owned by a live sender).
        self.assertFalse(ipc_linux.running(self.data))
        self.assertEqual(list(self.data.iterdir()), [])
        delivered, _ = ipc_linux.send_command(self.data, "start", timeout=2)
        self.assertFalse(delivered)

    def test_acquire_tolerates_transient_exclusive_hold(self):
        # Regression test for the intermittent cycle-test bring-up failure:
        # _lock_busy()'s liveness probe takes LOCK_EX for microseconds, and
        # an acquire() landing exactly in that window used to read as a live
        # instance (then waited 10s for a server that never comes). Hold the
        # lock from a second fd, release it after 100ms (orders of magnitude
        # longer than any probe hold), and require acquire() to succeed.
        ready = threading.Event()

        def hold():
            with open(ipc_linux.lock_path(self.data), "a+b") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                ready.set()
                time.sleep(0.1)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        try:
            self.assertTrue(ready.wait(timeout=10), "holder never took the lock")
            guard = ipc_linux.SingleInstance(self.data)
            self.assertTrue(
                guard.acquire(),
                "transient exclusive hold must not read as a live instance")
            guard.release()
        finally:
            thread.join(timeout=10)

    def test_acquire_still_reports_live_owner(self):
        # The retry above must stay bounded: a genuinely held lock still
        # reports False (after the retry window, not forever).
        with open(ipc_linux.lock_path(self.data), "a+b") as holder:
            fcntl.flock(holder.fileno(), fcntl.LOCK_EX)
            guard = ipc_linux.SingleInstance(self.data)
            started = time.monotonic()
            self.assertFalse(guard.acquire())
            self.assertLess(time.monotonic() - started, 5.0,
                            "acquire must stay bounded on a live owner")

    def test_running_reflects_lock_and_socket(self):
        self.assertFalse(ipc_linux.running(self.data))
        guard = ipc_linux.SingleInstance(self.data)
        self.assertTrue(guard.acquire())
        try:
            self.assertFalse(ipc_linux.running(self.data))  # lock held, no socket yet
            server = ipc_linux.CommandServer(self.data)
            server.start()
            try:
                self.assertTrue(ipc_linux.running(self.data))
            finally:
                server.stop()
        finally:
            guard.release()
        self.assertFalse(ipc_linux.running(self.data))


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aipster-dispatch-")
        self.addCleanup(self.temp.cleanup)
        self.ctl = FakeController(Path(self.temp.name))
        self.ctl.backend = FakeBackend(self.ctl.log)

    def test_ensure_reuses_and_shows(self):
        # A stopped tray starts on ensure (mirrors the Win32 ENSURE path);
        # an already-running tray is only notified and shown.
        self.ctl.state = state.STOPPED
        self.assertTrue(tray_main.dispatch(self.ctl, "ensure"))
        self.assertIn("start", self.ctl.actions)
        self.assertEqual(self.ctl.backend.shown, 1)
        self.assertEqual(self.ctl.backend.events[0][0], "reuse")

    def test_commands_map_to_worker_ops(self):
        for command in ("start", "stop", "restart", "quit"):
            with self.subTest(command=command):
                ctl = FakeController(Path(self.temp.name))
                ctl.backend = FakeBackend(ctl.log)
                self.assertTrue(tray_main.dispatch(ctl, command))
                self.assertIn(command, ctl.actions)


class TrayCliTests(unittest.TestCase):
    def test_status_without_state_is_exit_2(self):
        rc, out, _ = run_main(tray_main.main, ["status"])
        self.assertEqual(rc, 2)
        self.assertIn("never run", out)

    def test_status_with_state_reports_not_running(self):
        def write_state(data):
            first.private_directory(Path(data))
            state.write_state(Path(data) / "state.json", state.STOPPED, "",
                              None, "", 0, 0, "test", pairing=None)
            return 0

        with tempfile.TemporaryDirectory(prefix="aipster-tray-cli-") as temp:
            write_state(temp)
            with patch.dict(os.environ, {"AIPSTER_WORKER_DATA": temp}):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = tray_main.main(["status"])
        self.assertEqual(rc, 0)
        self.assertIn("state=stopped", out.getvalue())
        self.assertIn("tray not running", out.getvalue())

    def test_start_without_tray_is_exit_2(self):
        rc, _, err = run_main(tray_main.main, ["start"])
        self.assertEqual(rc, 2)
        self.assertIn("no running tray", err)

    def test_unknown_command_is_exit_2(self):
        rc, _, err = run_main(tray_main.main, ["frobnicate"])
        self.assertEqual(rc, 2)
        self.assertIn("unknown command", err)

    def test_full_run_cycle_headless(self):
        # A headless tray run serves IPC: status sees it live, quit stops it.
        # Needs the worker dependency closure (pydantic + dendrite chain);
        # the build venv provides it, plain system interpreters may not.
        try:
            import pydantic  # noqa: F401
            from dendrite import config as _  # noqa: F401
        except ImportError:
            self.skipTest("needs worker dependencies (run with the build venv)")
        with tempfile.TemporaryDirectory(prefix="aipster-cycle-") as temp:
            data = Path(temp) / "data"
            env = {"AIPSTER_WORKER_DATA": str(data)}
            with patch.dict(os.environ, env):
                config = data / "config.toml"
                first.private_directory(data)
                config.write_text((LINUX / "default.toml").read_text(encoding="utf-8"),
                                  encoding="utf-8")
                thread_rc = []
                thread = threading.Thread(
                    target=lambda: thread_rc.append(
                        tray_main.main(["run", "--headless"])),
                    daemon=True)
                thread.start()
                try:
                    live = False
                    for _ in range(100):
                        if ipc_linux.running(data):
                            live = True
                            break
                        time.sleep(0.2)
                    if not live:
                        # One-off bring-up failures must report discriminating
                        # facts (lock/socket/thread state), not just a bare
                        # timeout, so the next occurrence is actionable.
                        facts = {"thread_rc": list(thread_rc),
                                 "thread_alive": thread.is_alive(),
                                 "lock_exists": (data / "tray.lock").exists(),
                                 "sock_exists": (data / "tray.sock").exists()}
                        try:
                            probe = ipc_linux.SingleInstance(data)
                            facts["lock_reacquirable"] = probe.acquire()
                            if facts["lock_reacquirable"]:
                                probe.release()
                        except Exception as exc:  # noqa: BLE001 - diagnostics
                            facts["probe_error"] = repr(exc)
                        self.fail(f"tray did not come up: {facts}")
                    # The command socket binds before prepare() writes state:
                    # wait for the state file, not just the socket.
                    ready = False
                    for _ in range(150):
                        if state.read_state(data / "state.json") is not None:
                            ready = True
                            break
                        time.sleep(0.2)
                    self.assertTrue(ready, "tray did not publish state")
                    out = io.StringIO()
                    with redirect_stdout(out):
                        self.assertEqual(tray_main.main(["status"]), 0)
                    self.assertIn("(live)", out.getvalue())
                    with redirect_stdout(io.StringIO()):
                        self.assertEqual(tray_main.main(["quit"]), 0)
                    thread.join(timeout=30)
                    self.assertFalse(thread.is_alive(), "tray thread did not exit")
                finally:
                    if thread.is_alive():
                        with redirect_stdout(io.StringIO()), \
                                redirect_stderr(io.StringIO()):
                            try:
                                tray_main.main(["quit"])
                            except Exception:
                                pass
                        thread.join(timeout=30)
                self.assertEqual(thread_rc, [0])
                payload = state.read_state(data / "state.json")
                self.assertIsNotNone(payload)
                self.assertEqual(payload["state"], state.STOPPED)


class BackendLinuxTests(unittest.TestCase):
    def test_base_actions_return_targets_without_shell(self):
        backend = backend_linux.LinuxBaseBackend(lambda m: None)
        self.assertEqual(backend.open_dashboard("https://example.invalid"), "https://example.invalid")
        self.assertEqual(backend.open_logs("/tmp/x"), "/tmp/x")
        self.assertEqual(backend.open_config("/tmp/config.toml"), "/tmp/config.toml")
        self.assertIn(("open_config", "/tmp/config.toml"), backend.events)

    def test_copy_text_reports_bool(self):
        backend = backend_linux.LinuxBaseBackend(lambda m: None)
        with patch.object(backend_linux, "copy_via_helper", return_value=True):
            self.assertTrue(backend.copy_text("http://127.0.0.1:8090"))

    def test_pair_console_without_terminal_returns_target(self):
        backend = backend_linux.LinuxBaseBackend(lambda m: None)
        with patch.object(backend_linux, "find_terminal", return_value=(None, None)):
            exe, args = backend.run_pair_console("aipster-worker", ["pair"])
        self.assertEqual((exe, args), ("aipster-worker", ["pair"]))

    def test_window_degrades_gracefully_without_display(self):
        backend = backend_linux.LinuxWindowBackend(lambda m: None)
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("DISPLAY", None)
            os.environ.pop("WAYLAND_DISPLAY", None)
            backend.attach(FakeController(Path("/tmp/does-not-matter")))
        self.assertIsNone(backend.root)
        backend.refresh(state.RUNNING, "")  # must not raise windowless
        backend.detach()

    def test_window_renders_all_states(self):
        if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
            self.skipTest("needs an isolated display (run under xvfb-run)")
        import tkinter as tk  # noqa: F401 - proves tkinter imports where shown
        for st_name in state.STATES:
            backend = backend_linux.LinuxWindowBackend(lambda m: None)
            ctl = FakeController(Path("/tmp/does-not-matter"))
            ctl.state = st_name
            ctl.detail = "sample detail" if st_name in (state.PORT_BUSY, state.ERROR) else ""
            ctl.loaded = SimpleNamespace(node=SimpleNamespace(host="127.0.0.1", port=8090))
            ctl.pairing = {"key": state.PAIR_UNPAIRED, "line": state.UNPAIRED_LINE,
                           "sender": "Sender: stopped"}
            try:
                backend.attach(ctl)
                if backend.root is None:
                    self.skipTest("display unavailable to tkinter")
                backend.refresh_current()
                buttons = backend.widgets["action_buttons"]
                self.assertIn("quit", buttons)
                copy_button = buttons["copy_endpoint"]
                expect_enabled = st_name in (state.STARTING, state.RUNNING) and bool(
                    ctl.endpoint_label())
                self.assertEqual(str(copy_button["state"]),
                                 "normal" if expect_enabled else "disabled")
                # Every shipped label stays inside the honesty gate.
                for item in state.menu_model(st_name, ctl.endpoint_label(), ctl.detail,
                                             ctl.pairing):
                    if item["kind"] == "text":
                        state.check_honest(item["label"])
            finally:
                backend.detach()

    def test_window_action_buttons_drive_menu_actions(self):
        if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
            self.skipTest("needs an isolated display (run under xvfb-run)")
        backend = backend_linux.LinuxWindowBackend(lambda m: None)
        ctl = FakeController(Path("/tmp/does-not-matter"))
        ctl.state = state.STOPPED
        ctl.pairing = {"key": state.PAIR_UNPAIRED, "line": state.UNPAIRED_LINE,
                       "sender": "Sender: stopped"}
        try:
            backend.attach(ctl)
            if backend.root is None:
                self.skipTest("display unavailable to tkinter")
            backend.refresh_current()
            backend.widgets["action_buttons"]["start"].invoke()
            backend.widgets["action_buttons"]["quit"].invoke()
        finally:
            backend.detach()
        self.assertEqual(ctl.actions, ["start", "quit"])

    def test_indicator_probe_returns_none_or_backend(self):
        result = backend_linux.try_indicator(lambda m: None)
        self.assertTrue(result is None or isinstance(result, backend_linux.LinuxBaseBackend))


class LauncherTests(unittest.TestCase):
    def test_version_reports_build(self):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = launcher.main(["--version"])
        self.assertEqual(rc, 0)
        self.assertTrue(out.getvalue().strip())

    def test_tray_status_passthrough_without_state(self):
        rc, out, _ = run_main(launcher.main, ["tray", "status"])
        self.assertEqual(rc, 2)
        self.assertIn("never run", out)

    def test_runtime_plan_requires_config(self):
        with self.assertRaises(SystemExit) as raised:
            launcher.main(["runtime-plan"])
        self.assertEqual(raised.exception.code, 2)

    def test_autostart_defaults_off_then_on_then_off(self):
        with tempfile.TemporaryDirectory(prefix="aipster-autostart-") as temp:
            env = {"XDG_CONFIG_HOME": temp}
            rc, out, _ = run_main(launcher.main, ["autostart", "status"], env)
            self.assertEqual(rc, 0)
            self.assertIn("off", out)
            rc, out, _ = run_main(launcher.main, ["autostart", "on"], env)
            self.assertEqual(rc, 0)
            entry = Path(temp) / "autostart" / "aipster-worker.desktop"
            self.assertTrue(entry.is_file())
            self.assertIn("AIPSTER Worker", entry.read_text(encoding="utf-8"))
            rc, out, _ = run_main(launcher.main, ["autostart", "status"], env)
            self.assertIn("on", out)
            rc, _, _ = run_main(launcher.main, ["autostart", "off"], env)
            self.assertEqual(rc, 0)
            self.assertFalse(entry.exists())

    def test_autostart_entry_points_at_tray(self):
        text = launcher.autostart_entry()
        self.assertIn("aipster-tray", text)
        self.assertIn("[Desktop Entry]", text)


class DeliveryCheckTests(unittest.TestCase):
    def test_linux_names_are_extensionless(self):
        self.assertIn("aipster-tray", delivery.REQUIRED_APP_FILES)
        self.assertNotIn("aipster-tray.exe", delivery.REQUIRED_APP_FILES)
        self.assertEqual(delivery.TRAY_EXE, "aipster-tray")

    def test_mock_store_is_blocked_not_ready(self):
        with tempfile.TemporaryDirectory(prefix="aipster-delivery-") as temp:
            app_dir = Path(temp) / "app"
            app_dir.mkdir()
            for name in ("aipster-tray", "aipster-worker", "aipster-dendrite",
                         "BUILD.json", "default.toml"):
                (app_dir / name).write_text("{}", encoding="utf-8")
            (app_dir / "BUILD.json").write_text(
                '{"worker_name": "ganglion-dendrite", "worker_version": "0.1.0"}',
                encoding="utf-8")
            data = Path(temp) / "data"
            data.mkdir()
            (data / "config.toml").write_text(
                (LINUX / "default.toml").read_text(encoding="utf-8"), encoding="utf-8")
            result = delivery.check_delivery(app_dir, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("mock", result["reason"].lower() + str(result.get("runtime", {})).lower())


class DebTemplateTests(unittest.TestCase):
    def test_control_template(self):
        text = (LINUX / "deb/control").read_text(encoding="utf-8")
        self.assertIn("Package: aipster-worker", text)
        self.assertIn("Architecture: amd64", text)
        self.assertIn("@VERSION@", text)
        self.assertIn("@DEPENDS@", text)

    def test_control_renders(self):
        template = (LINUX / "deb/control").read_text(encoding="utf-8")
        rendered = template.replace("@VERSION@", "0.1.0-1").replace("@DEPENDS@", "libc6")
        self.assertTrue(all(len(line) < 200 for line in rendered.splitlines()))
        fields = dict(line.split(":", 1) for line in rendered.splitlines()
                      if ":" in line and not line.startswith(" "))
        self.assertEqual(fields["Package"].strip(), "aipster-worker")

    def test_maintainer_scripts_are_sh_and_never_touch_home(self):
        for name in ("postinst", "prerm", "postrm"):
            text = (LINUX / "deb" / name).read_text(encoding="utf-8")
            self.assertTrue(text.startswith("#!/bin/sh"), name)
            # Safety property covers commands, not prose: strip comments and
            # blank lines, then require the remainder to be inert.
            commands = [line for line in text.splitlines()
                        if line.strip() and not line.strip().startswith("#")]
            joined = "\n".join(commands)
            self.assertNotIn("rm ", joined, name)
            self.assertNotIn("$HOME", joined, name)
            self.assertNotIn("~", joined, name)
            self.assertNotIn("pkill", joined, name)
            self.assertNotIn("kill", joined, name)

    def test_postrm_preserves_data_even_on_purge(self):
        text = (LINUX / "deb/postrm").read_text(encoding="utf-8")
        self.assertIn("NEVER", text)

    def test_desktop_entry(self):
        text = (LINUX / "desktop/aipster-worker.desktop").read_text(encoding="utf-8")
        entry = dict(line.split("=", 1) for line in text.splitlines()
                     if "=" in line and not line.startswith("["))
        self.assertEqual(entry["Type"], "Application")
        self.assertEqual(entry["Exec"], "/usr/bin/aipster-tray")
        self.assertEqual(entry["Icon"], "aipster-worker")
        self.assertEqual(entry["Terminal"], "false")
        self.assertTrue(entry["Name"])

    def test_icons_cover_hicolor_sizes(self):
        for size in ("16x16", "22x22", "24x24", "32x32", "48x48", "64x64",
                     "128x128", "256x256"):
            icon = LINUX / "icons/hicolor" / size / "apps/aipster-worker.png"
            self.assertTrue(icon.is_file(), icon)
            # PNG magic + IHDR present (stdlib-rendered, committed).
            header = icon.read_bytes()[:33]
            self.assertTrue(header.startswith(b"\x89PNG\r\n\x1a\n"), icon)
            self.assertIn(b"IHDR", header, icon)

    def test_spec_keeps_tkinter(self):
        text = (LINUX / "dendrite_linux.spec").read_text(encoding="utf-8")
        self.assertNotIn('"tkinter"', text.split("excludes=")[1].split("]")[0])

    def test_build_helpers(self):
        self.assertTrue(build.HERE.is_dir())
        debian_version = build.write_control.__doc__ or ""
        self.assertIsInstance(debian_version, str)
        notes = (LINUX / "deb/README.Debian").read_text(encoding="utf-8")
        self.assertIn("aipster-worker", notes)

    def test_stage_deb_tree_layout(self):
        with tempfile.TemporaryDirectory(prefix="aipster-stage-") as temp:
            app = Path(temp) / "app"
            app.mkdir()
            for name in ("aipster-tray", "aipster-worker", "aipster-dendrite",
                         "BUILD.json", "default.toml"):
                (app / name).write_text("x", encoding="utf-8")
            root = Path(temp) / "deb-root"
            root.mkdir()
            build.stage_deb_tree(root, app, "0.1.0", depends=[])
            self.assertTrue((root / "usr/lib/aipster-worker/app/aipster-tray").is_file())
            # /usr/bin entries are wrappers (no RUNPATH on frozen exes), not
            # symlinks: they point LD_LIBRARY_PATH at the private app dir.
            wrapper = root / "usr/bin/aipster-tray"
            self.assertTrue(wrapper.is_file())
            self.assertFalse(wrapper.is_symlink())
            text = wrapper.read_text(encoding="utf-8")
            self.assertIn('LD_LIBRARY_PATH="/usr/lib/aipster-worker/app', text)
            self.assertIn('exec "/usr/lib/aipster-worker/app/aipster-tray" "$@"', text)
            self.assertTrue(os.access(wrapper, os.X_OK))
            self.assertTrue((root / "usr/share/applications/aipster-worker.desktop").is_file())
            self.assertTrue((root / "usr/share/icons/hicolor/48x48/apps/"
                                   "aipster-worker.png").is_file())
            self.assertTrue((root / "usr/share/doc/aipster-worker/copyright").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
