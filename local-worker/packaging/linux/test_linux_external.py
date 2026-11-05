"""Externally managed worker status + window/indicator parity. No display needed.

Never touches systemd, services, the network (the /healthz probe is injected),
pairing, or config.toml. Tk/Gtk rendering on a real desktop stays with the
Xvfb/XFCE checks; this file covers the shared view model and action routing.
"""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

LINUX = Path(__file__).resolve().parent
PACKAGING = LINUX.parent
ROOT = PACKAGING.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(PACKAGING))
sys.path.insert(0, str(ROOT))

from aipster_tray import backend_linux as bl  # noqa: E402
from aipster_tray import linux_external as ext  # noqa: E402
from aipster_tray import state as st  # noqa: E402
from aipster_tray.app_settings_linux import save_settings  # noqa: E402


def items(state_name):
    return st.menu_model(state_name, endpoint="", detail="port 8090 is already in use")


class FakeController:
    def __init__(self, data, state_name=st.STOPPED):
        self.data = Path(data)
        self.state = state_name
        self.detail = "port 8090 is already in use" if state_name == st.PORT_BUSY else ""
        self.loaded = SimpleNamespace(node=SimpleNamespace(host="127.0.0.1", port=8090))
        self.pairing = None
        self.actions = []

    def endpoint_label(self):
        return "http://127.0.0.1:8090"

    def menu_action(self, action):
        self.actions.append(action)


def backend(cls, data, state_name, healthy):
    b = cls(lambda m: None) if cls is not bl.LinuxIndicatorBackend \
        else cls(lambda m: None, "ayatana")
    b.controller = FakeController(data, state_name)
    b.probes = []

    def probe(host, port):
        b.probes.append((host, port))
        return healthy
    b.health_probe = probe
    b.notes = []
    b.note_to_user = b.notes.append
    return b


class ExternalHelperTests(unittest.TestCase):
    def test_owned_states_unchanged(self):
        for s in (st.STOPPED, st.STARTING, st.RUNNING, st.ERROR):
            base = items(s)
            header, note, out = ext.present(s, "", "127.0.0.1", 8090, True, base)
            self.assertEqual(out, base)
            self.assertEqual(note, "")
            self.assertEqual(ext.classify(s, True), "")

    def test_healthy_external_disables_control_and_never_overclaims(self):
        header, note, out = ext.present(st.PORT_BUSY, "x", "127.0.0.1", 8090, True,
                                        items(st.PORT_BUSY))
        self.assertIn("outside this app", header)
        self.assertIn("http://127.0.0.1:8090", note)
        self.assertIn("not verified", note)
        acts = {i["id"]: i for i in out if i["kind"] == "action"}
        self.assertFalse(acts["start"]["enabled"])
        self.assertNotIn("stop", acts)
        for keep in ("dashboard", "logs", "pair", "connect", "settings", "quit"):
            self.assertTrue(acts[keep]["enabled"], keep)
        for text in [header, note] + [i.get("label", "") for i in out]:
            st.check_honest(text)
        self.assertNotIn("systemd", (header + note).lower())  # no invented unit

    def test_unhealthy_holder_keeps_error_and_explicit_retry(self):
        base = items(st.PORT_BUSY)
        header, note, out = ext.present(st.PORT_BUSY, "x", "127.0.0.1", 8090, False, base)
        self.assertIn("Port busy", header)
        self.assertIn("will not stop or replace", note)
        self.assertEqual(out, base)

    def test_never_enables_anything_and_never_mutates(self):
        for s in st.STATES:
            for h in (True, False):
                base = items(s)
                snap = [dict(i) for i in base]
                _, _, out = ext.present(s, "", "::1", 8090, h, base)
                self.assertEqual(base, snap)
                for b, o in zip(base, out):
                    if o.get("enabled"):
                        self.assertTrue(b.get("enabled"))


class BackendParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name
        Path(self.data, "config.toml").write_text("runtime sentinel")
        Path(self.data, "pairing.json").write_text("pairing sentinel")

    def tearDown(self):
        for name, text in (("config.toml", "runtime sentinel"),
                           ("pairing.json", "pairing sentinel")):
            self.assertEqual(Path(self.data, name).read_text(), text)
        self.tmp.cleanup()

    def test_probe_only_when_port_busy_and_cached(self):
        b = backend(bl.LinuxWindowBackend, self.data, st.RUNNING, True)
        self.assertFalse(b.external_health(st.RUNNING))
        self.assertEqual(b.probes, [])
        b.controller.state = st.PORT_BUSY
        self.assertTrue(b.external_health(st.PORT_BUSY))
        self.assertTrue(b.external_health(st.PORT_BUSY))
        self.assertEqual(b.probes, [("127.0.0.1", 8090)])  # cached

    def test_probe_error_is_not_healthy(self):
        b = backend(bl.LinuxWindowBackend, self.data, st.PORT_BUSY, True)

        def boom(host, port):
            raise OSError("refused")
        b.health_probe = boom
        self.assertFalse(b.external_health(st.PORT_BUSY))

    def test_external_healthy_view_and_refused_start(self):
        for cls in (bl.LinuxWindowBackend, bl.LinuxIndicatorBackend):
            b = backend(cls, self.data, st.PORT_BUSY, True)
            view = b.view_model(st.PORT_BUSY, b.controller.detail)
            self.assertIn("outside this app", view["header"])
            acts = {i["id"]: i for i in view["items"] if i["kind"] == "action"}
            self.assertFalse(acts["start"]["enabled"])
            b.handle_action("start")
            b.handle_action("stop")
            self.assertEqual(b.controller.actions, [], cls.name)
            self.assertEqual(b.notes, [bl.EXTERNAL_CONTROL_NOTE] * 2)
            b.handle_action("pair")
            self.assertEqual(b.controller.actions, ["pair"])

    def test_unhealthy_port_busy_still_routes_start(self):
        b = backend(bl.LinuxWindowBackend, self.data, st.PORT_BUSY, False)
        view = b.view_model(st.PORT_BUSY, b.controller.detail)
        self.assertEqual(view["header"], ext.UNHEALTHY_HEADER)
        b.handle_action("start")
        self.assertEqual(b.controller.actions, ["start"])

    def test_copy_follows_fabric_settings_not_worker_state(self):
        for cls in (bl.LinuxWindowBackend, bl.LinuxIndicatorBackend):
            b = backend(cls, self.data, st.STOPPED, False)
            copied = []
            b.copy_text = lambda text: copied.append(text) or True
            acts = {i["id"]: i for i in b.view_model(st.STOPPED)["items"]
                    if i["kind"] == "action"}
            self.assertFalse(acts["copy_endpoint"]["enabled"])
            self.assertFalse(b.copy_fabric())
            save_settings(self.data, "https://fabric.example", True)
            view = b.view_model(st.STOPPED)
            acts = {i["id"]: i for i in view["items"] if i["kind"] == "action"}
            self.assertTrue(acts["copy_endpoint"]["enabled"])
            self.assertEqual(acts["copy_endpoint"]["label"], bl.COPY_FABRIC_LABEL)
            self.assertEqual(view["endpoint_note"], bl.FABRIC_CONFIGURED_NOTE)
            b.handle_action("copy_endpoint")
            self.assertEqual(copied, ["https://fabric.example/v1"])
            self.assertEqual(b.controller.actions, [])  # never the local address
            save_settings(self.data, "", False)

    def test_local_address_is_never_the_endpoint(self):
        b = backend(bl.LinuxIndicatorBackend, self.data, st.RUNNING, False)
        labels = [i.get("label", "") for i in
                  b.menu_items(b.view_model(st.RUNNING))]
        self.assertFalse([t for t in labels if "8090" in t])
        self.assertIn(bl.ENDPOINT_UNAVAILABLE_NOTE, labels)

    def test_settings_bypasses_controller_config_gate(self):
        win = backend(bl.LinuxWindowBackend, self.data, st.STOPPED, False)
        win.handle_action("settings")  # windowless: says so, never silent
        self.assertEqual(win.notes, [bl.SETTINGS_UNAVAILABLE_NOTE])
        self.assertEqual(win.controller.actions, [])
        opened = []
        win.open_config = lambda path=None: opened.append(path) or "dialog"
        win.handle_action("settings")
        self.assertEqual(opened, [None])

    def test_save_fabric_settings_writes_app_settings_only(self):
        b = backend(bl.LinuxIndicatorBackend, self.data, st.STOPPED, False)
        ok, msg = b.save_fabric_settings("https://fabric.example", False)
        self.assertFalse(ok)
        ok, msg = b.save_fabric_settings("http://127.0.0.1:8090/v1", True)
        self.assertFalse(ok)
        self.assertIn("control address", msg)
        ok, msg = b.save_fabric_settings("https://fabric.example", True)
        self.assertTrue(ok)
        self.assertIn("not verified", msg)
        stored = json.loads(Path(self.data, "app-settings.json").read_text())
        self.assertEqual(stored["status"], "configured_unverified")
        for text in (bl.EXTERNAL_CONTROL_NOTE, bl.SETTINGS_UNAVAILABLE_NOTE,
                     bl.COPY_FABRIC_LABEL, bl.FABRIC_CONFIGURED_NOTE, msg):
            st.check_honest(text)


class DeclaredRecordTests(unittest.TestCase):
    """Persistent external-management record (Linux controller interface)."""

    def make(self, data, state_name, record, healthy=False):
        b = backend(bl.LinuxWindowBackend, data, state_name, healthy)
        calls = []

        def reader():
            calls.append(1)
            if isinstance(record, Exception):
                raise record
            return record
        b.controller.external_record = reader
        return b, calls

    def test_declared_disables_start_in_every_state(self):
        with tempfile.TemporaryDirectory() as d:
            for s in (st.STOPPED, st.ERROR, st.PORT_BUSY):
                for record in ({"valid": True, "source": "observed", "origin": "x"},
                               {"valid": False, "reason": "invalid"}, OSError("x")):
                    b, calls = self.make(d, s, record)
                    view = b.view_model(s, b.controller.detail)
                    acts = {i["id"]: i for i in view["items"] if i["kind"] == "action"}
                    self.assertFalse(acts["start"]["enabled"], (s, record))
                    self.assertIn("managed outside this app", view["header"])
                    st.check_honest(view["header"])
                    self.assertTrue(calls)
                    b.handle_action("start")
                    self.assertEqual(b.controller.actions, [])
                    self.assertEqual(b.notes[-1], bl.EXTERNAL_CONTROL_NOTE)
                    b.handle_action("pair")  # pairing stays available
                    self.assertEqual(b.controller.actions, ["pair"])

    def test_declared_and_healthy_keeps_running_outside_header(self):
        with tempfile.TemporaryDirectory() as d:
            b, _ = self.make(d, st.PORT_BUSY, {"valid": True}, healthy=True)
            view = b.view_model(st.PORT_BUSY, b.controller.detail)
            self.assertEqual(view["header"], ext.HEALTHY_HEADER)

    def test_no_record_or_no_interface_is_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            b, _ = self.make(d, st.STOPPED, None)
            acts = {i["id"]: i for i in b.view_model(st.STOPPED)["items"]
                    if i["kind"] == "action"}
            self.assertTrue(acts["start"]["enabled"])
            plain = backend(bl.LinuxWindowBackend, d, st.STOPPED, False)
            self.assertFalse(hasattr(plain.controller, "external_record"))
            self.assertFalse(plain.external_declared())
            plain.handle_action("start")
            self.assertEqual(plain.controller.actions, ["start"])


def fake_gi():
    """Minimal gi/Gtk stand-in recording widgets; no display, no GI typelibs."""
    created = {}

    class Widget:
        def __init__(self, *a, **kw):
            self.kw = kw
            self.children = []
            self.handlers = {}
            self.text = kw.get("label", "")
            self.active = False
            self.sensitive = True
            self.destroyed = False

        def add(self, child):
            self.children.append(child)

        def append(self, child):
            self.children.append(child)

        def set_spacing(self, *_):
            pass

        set_border_width = set_width_chars = set_spacing

        def get_content_area(self):
            return self

        def set_text(self, text):
            self.text = text

        def get_text(self):
            return self.text

        def set_active(self, value):
            self.active = bool(value)

        def get_active(self):
            return self.active

        def set_sensitive(self, value):
            self.sensitive = bool(value)

        def connect(self, signal, func):
            self.handlers.setdefault(signal, []).append(func)

        def add_button(self, *_):
            pass

        def show_all(self):
            pass

        def present(self):
            if self.destroyed:
                raise RuntimeError("destroyed")

        def destroy(self):
            self.destroyed = True

        def set_menu(self, menu):
            created["menu"] = menu

        def set_tooltip_text(self, text):
            created["tooltip"] = text

    def factory(name):
        def make(*a, **kw):
            w = Widget(*a, **kw)
            created.setdefault(name, []).append(w)
            return w
        return make

    gtk = types.SimpleNamespace(
        Menu=factory("Menu"), MenuItem=factory("MenuItem"),
        SeparatorMenuItem=factory("Sep"), Dialog=factory("Dialog"),
        Label=factory("Label"), Entry=factory("Entry"),
        CheckButton=factory("CheckButton"),
        ResponseType=types.SimpleNamespace(OK=-5, CANCEL=-6))
    repo = types.ModuleType("gi.repository")
    repo.Gtk = gtk
    gi = types.ModuleType("gi")
    gi.require_version = lambda *a: None
    gi.repository = repo
    return {"gi": gi, "gi.repository": repo}, created


class IndicatorFakeGtkTests(unittest.TestCase):
    def test_menu_and_native_settings_dialog(self):
        mods, created = fake_gi()
        with tempfile.TemporaryDirectory() as data, patch.dict(sys.modules, mods):
            Path(data, "config.toml").write_text("runtime sentinel")
            b = backend(bl.LinuxIndicatorBackend, data, st.PORT_BUSY, True)
            b.indicator = mods["gi.repository"].Gtk.Menu()  # stand-in indicator
            b._rebuild_menu()
            labels = [w.text for w in created["MenuItem"]]
            self.assertTrue(any("outside this app" in t for t in labels))
            start = [w for w in created["MenuItem"] if w.text == ext.CONTROL_UNAVAILABLE]
            self.assertTrue(start and not start[0].sensitive)
            self.assertIn("outside this app", created["tooltip"])
            dialog = b.open_app_settings()
            entry = created["Entry"][0]
            check = created["CheckButton"][0]
            respond = dialog.handlers["response"][0]
            entry.set_text("https://fabric.example")
            respond(dialog, -5)  # unconfirmed: feedback, dialog stays
            self.assertFalse(dialog.destroyed)
            self.assertIn("Confirm", created["Label"][-1].text)
            check.set_active(True)
            respond(dialog, -5)
            self.assertTrue(dialog.destroyed)
            self.assertIn("not verified", b.notes[-1])
            self.assertEqual(Path(data, "config.toml").read_text(), "runtime sentinel")
            labels = [w.text for w in created["MenuItem"]]
            self.assertIn("Fabric: https://fabric.example/v1 (not verified)", labels)

    def test_statusicon_popup_connected_once(self):
        mods, created = fake_gi()
        with tempfile.TemporaryDirectory() as data, patch.dict(sys.modules, mods):
            b = backend(bl.LinuxIndicatorBackend, data, st.STOPPED, False)
            b.flavor = "statusicon"
            b.indicator = mods["gi.repository"].Gtk.Menu()
            for _ in range(3):
                b._rebuild_menu()
            self.assertEqual(len(b.indicator.handlers["popup-menu"]), 1)


if __name__ == "__main__":
    unittest.main()
