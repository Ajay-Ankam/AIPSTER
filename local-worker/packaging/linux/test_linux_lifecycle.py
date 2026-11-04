"""Linux tray lifecycle guard: no duplicate worker/sender beside an external one.

No display, network, systemd, services, or real config: port/health probes,
the worker child and the sender are injected fakes.
"""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

LINUX = Path(__file__).resolve().parent
PACKAGING = LINUX.parent
ROOT = PACKAGING.parent
sys.dont_write_bytecode = True
for p in (str(LINUX), str(PACKAGING), str(ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

from aipster_tray import controller as ctl  # noqa: E402
from aipster_tray import linux_lifecycle as lc  # noqa: E402
from aipster_tray import state as st  # noqa: E402


class FakeChild:
    def __init__(self):
        self.starts = 0
        self._pid = None

    def start(self, config, env):
        self.starts += 1
        self._pid = 4242

    def pid(self):
        return self._pid

    def exited(self):
        return None if self._pid else 0

    def running(self):
        return bool(self._pid)

    def stop(self):
        self._pid = None

    confined = True
    confine_error = ""


class FakeSender:
    def __init__(self):
        self.starts = 0

    def running(self):
        return False

    def start(self):
        self.starts += 1
        return 4343

    def exited(self):
        return None

    def stop(self):
        pass

    confined = True
    confine_error = ""


class FakeBackend:
    name = "fake"

    def __init__(self):
        self.states = []

    def refresh(self, state, detail=""):
        self.states.append((state, detail))

    def notify(self, *a, **kw):
        pass


class Env:
    """Port/health world: busy/healthy flags read by the patched probes."""

    def __init__(self):
        self.busy = False
        self.healthy = False
        self.health_calls = 0

    def port_busy(self, host, port):
        return self.busy

    def health_ok(self, host, port):
        self.health_calls += 1
        return self.healthy


def make(data, cls=lc.LinuxController):
    c = cls(data, FakeBackend())
    c.child = FakeChild()
    c.sender = FakeSender()
    c.config = Path(data) / "config.toml"

    def reload():
        c.loaded = SimpleNamespace(node=SimpleNamespace(host="127.0.0.1", port=8090,
                                                        token_env="T"))
        c.token_env, c.token_value = "T", "x"
        return ""
    c._reload = reload
    c.state = st.STOPPED
    return c


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "config.toml").write_text("runtime sentinel")
        (self.data / "pairing.json").write_text("pairing sentinel")
        self.env = Env()
        for target, fn in (("port_busy", self.env.port_busy),
                           ("_health_ok", self.env.health_ok)):
            p = patch.object(ctl, target, fn)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def tearDown(self):
        self.assertEqual((self.data / "config.toml").read_text(), "runtime sentinel")
        self.assertEqual((self.data / "pairing.json").read_text(), "pairing sentinel")

    def record(self):
        return self.data / lc.EXTERNAL_FILE

    def test_no_record_free_port_spawns_as_before(self):
        c = make(self.data)
        self.assertTrue(c.start_worker())
        self.assertEqual(c.child.starts, 1)
        self.assertEqual(c.state, st.STARTING)
        self.assertFalse(self.record().exists())

    def test_healthy_external_holder_is_recorded_and_never_duplicated(self):
        self.env.busy, self.env.healthy = True, True
        c = make(self.data)
        self.assertFalse(c.start_worker(manual=False))
        self.assertEqual((c.child.starts, c.sender.starts), (0, 0))
        self.assertEqual(c.state, st.PORT_BUSY)
        self.assertIn("Managed outside this app", c.detail)
        info = os.lstat(self.record())
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(info.st_mode & 0o777, 0o600)
        stored = json.loads(self.record().read_text())
        self.assertEqual((stored["version"], stored["source"], stored["origin"]),
                         (1, "observed", "http://127.0.0.1:8090"))
        self.assertFalse(list(self.data.glob(".external-worker-*")))

    def test_service_restart_window_never_spawns_by_any_path(self):
        self.env.busy, self.env.healthy = True, True
        c = make(self.data)
        c.start_worker()  # observe + record
        # System service restarts: port briefly free, nothing answers health.
        self.env.busy, self.env.healthy = False, False
        import tray_main
        for path in (lambda: c.start_worker(),                       # menu Start
                     lambda: c.start_worker(manual=False),           # launch autostart
                     lambda: tray_main.dispatch(c, "ensure"),        # second launch
                     lambda: tray_main.dispatch(c, "start"),         # IPC start
                     lambda: tray_main.dispatch(c, "restart"),       # IPC restart
                     lambda: c.connect(),                            # one-click connect
                     lambda: c.start_sender()):
            with patch.object(c, "launch_pair", lambda: False):
                path()
        c.restart_at = 0  # an elapsed crash-backoff retry
        c.tick()
        self.assertEqual((c.child.starts, c.sender.starts), (0, 0))
        self.assertEqual(c.state, st.STOPPED)
        self.assertIn(str(self.record()), c.detail)

    def test_operator_record_blocks_without_any_probe(self):
        self.record().write_text(json.dumps({"version": 1, "source": "operator"}))
        os.chmod(self.record(), 0o600)
        c = make(self.data)
        self.assertFalse(c.start_worker())
        self.assertEqual(c.child.starts, 0)
        self.assertEqual(self.env.health_calls, 0)
        self.assertTrue(c.external["valid"])

    def test_untrusted_records_fail_closed(self):
        other = self.data / "elsewhere.json"
        other.write_text(json.dumps({"version": 1}))
        cases = {"symlink": lambda: os.symlink(other, self.record()),
                 "invalid": lambda: self.record().write_text("{bad"),
                 "wrong-version": lambda: self.record().write_text('{"version": 2}'),
                 "directory": lambda: self.record().mkdir(),
                 "oversized": lambda: self.record().write_text(
                     json.dumps({"version": 1, "pad": "x" * lc.MAX_RECORD_BYTES}))}
        for name, create in cases.items():
            with self.subTest(name):
                create()
                c = make(self.data)
                self.assertFalse(c.start_worker())
                self.assertEqual(c.child.starts, 0)
                self.assertFalse(c.external["valid"])
                self.assertIn("unreadable or invalid", c.detail)
                if self.record().is_dir() and not self.record().is_symlink():
                    self.record().rmdir()
                else:
                    self.record().unlink()
        self.assertEqual(other.read_text(), json.dumps({"version": 1}))

    def test_foreign_owner_fails_closed(self):
        self.record().write_text(json.dumps({"version": 1}))
        other_uid = os.getuid() + 1
        with patch.object(lc.os, "getuid", lambda: other_uid):
            c = make(self.data)
            self.assertFalse(c.start_worker())
        self.assertEqual(c.external["reason"], "owned by another user")

    def test_unhealthy_foreign_holder_keeps_original_port_busy_path(self):
        self.env.busy, self.env.healthy = True, False
        c = make(self.data)
        self.assertFalse(c.start_worker())
        self.assertEqual(c.state, st.PORT_BUSY)
        self.assertEqual(c.detail, "port 8090 is already in use")
        self.assertFalse(self.record().exists())
        self.assertEqual(c.child.starts, 0)

    def test_deleting_record_returns_control_to_this_app(self):
        self.env.busy, self.env.healthy = True, True
        c = make(self.data)
        c.start_worker()
        self.env.busy, self.env.healthy = False, False
        self.record().unlink()
        self.assertTrue(c.start_worker())
        self.assertEqual(c.child.starts, 1)

    def test_own_running_child_is_never_recorded_as_external(self):
        c = make(self.data)
        c.start_worker()
        c.state = st.RUNNING
        self.env.busy, self.env.healthy = True, True  # our own child holds the port
        self.assertTrue(c.start_worker())
        c.state = st.STOPPED  # e.g. a state glitch while our child is still alive
        c.start_worker()
        self.assertFalse(self.record().exists())

    def test_record_never_replaces_existing(self):
        self.record().write_text(json.dumps({"version": 1, "source": "operator"}))
        self.assertFalse(lc.record_external(self.data, "127.0.0.1", 8090))
        self.assertEqual(json.loads(self.record().read_text())["source"], "operator")

    def test_shared_controller_and_windows_unchanged(self):
        self.assertIsNot(lc.LinuxController.start_worker, ctl.Controller.start_worker)
        self.assertNotIn("external", ctl.Controller.start_worker.__code__.co_names)
        c = make(self.data, ctl.Controller)
        self.record().write_text(json.dumps({"version": 1}))
        self.assertTrue(c.start_worker())  # base class ignores the Linux record
        import tray_main
        self.assertIs(tray_main.LinuxController, lc.LinuxController)

    def cli(self, *args):
        import io
        import tray_main
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {"AIPSTER_WORKER_DATA": str(self.data)}), \
                patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            rc = tray_main.main(list(args))
        return rc, out.getvalue() + err.getvalue()

    def test_preseed_declare_before_first_launch_closes_restart_race(self):
        rc, text = self.cli("declare-external")
        self.assertEqual(rc, 0, text)
        self.assertIn("declared: ", text)
        info = os.lstat(self.record())
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(info.st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.record().read_text())["source"], "operator")
        self.assertFalse(list(self.data.glob(".external-worker-*")))
        # First launch lands inside a service restart: port free, no health.
        c = make(self.data)
        self.assertFalse(c.start_worker(manual=False))
        self.assertFalse(c.start_sender())
        self.assertEqual((c.child.starts, c.sender.starts, self.env.health_calls), (0, 0, 0))
        rc, text = self.cli("declare-external")  # idempotent, never rewrites
        self.assertEqual((rc, "already declared: " in text), (0, True))

    def test_preseed_rollback_and_untrusted_entries(self):
        self.cli("declare-external")
        rc, text = self.cli("clear-external")
        self.assertEqual(rc, 0)
        self.assertIn("cleared: ", text)
        self.assertFalse(os.path.lexists(self.record()))
        self.assertTrue(make(self.data).start_worker())  # control returns to the app
        self.assertEqual(self.cli("clear-external")[0], 0)  # nothing to clear
        self.record().mkdir()
        self.assertEqual(self.cli("declare-external")[0], 2)  # invalid: reported
        self.assertEqual(self.cli("clear-external")[0], 2)    # never rmtree
        self.assertTrue(self.record().is_dir())
        self.record().rmdir()
        target = self.data / "target.json"
        target.write_text("keep")
        os.symlink(target, self.record())
        self.assertEqual(self.cli("clear-external")[0], 0)  # removes the link only
        self.assertEqual(target.read_text(), "keep")

    def test_help_lists_preseed_commands(self):
        rc, text = self.cli("--help")
        self.assertEqual(rc, 0)
        self.assertIn("declare-external", text)
        self.assertIn("clear-external", text)

    def test_status_text_is_honest(self):
        for text in (lc.EXTERNAL_DETAIL, lc.INVALID_DETAIL):
            st.check_honest(text)
            self.assertNotIn("systemd", text.lower())


if __name__ == "__main__":
    unittest.main()
