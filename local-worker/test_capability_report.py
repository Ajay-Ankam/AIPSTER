"""Node capability report tests (opt-in --report-capabilities / capabilities-once).

Unit tests use a fake in-thread API (stdlib only). The E2E class drives the
real pairing.py CLI against the real worker.js through the existing
pairing-e2e bridge, and skips honestly when node or website deps are absent.
All keys are synthetic fixtures; no real data dir, network host or model.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing
from pairing import (PairingError, RePairRequired, build_capability_report,
                     send_capabilities, cmd_heartbeat, EXIT_OK, EXIT_NETWORK,
                     EXIT_PAIRING_REJECTED, EXIT_REPAIR_REQUIRED)

FAKE_SECRET = "synthetic-heartbeat-key-0123456789abcdef"
ALLOWED_KEYS = {"schema_version", "os", "arch", "runtimes", "mem", "disk", "workload"}
GIB = 1024 ** 3

try:
    import dendrite.config  # noqa: F401
    HAVE_DENDRITE = True
except ImportError:
    HAVE_DENDRITE = False


def server_accepts(body):
    """Python mirror of validateCapabilityBody (website/src/worker.js).

    Returns None when the server would accept the body, else the reason.
    Kept deliberately literal so a drift between the two shows up here.
    """
    if not isinstance(body, dict):
        return "not an object"
    if set(body) - ALLOWED_KEYS:
        return "unknown field"
    if body.get("schema_version") != 1:
        return "schema_version"
    for f in ("os", "arch"):
        if not isinstance(body.get(f), str) or not body[f] or len(body[f]) > 64:
            return f
    runtimes = body.get("runtimes")
    if not isinstance(runtimes, list) or len(runtimes) > 16:
        return "runtimes"
    for r in runtimes:
        if not isinstance(r, dict) or not isinstance(r.get("name"), str) or not r["name"] or len(r["name"]) > 64:
            return "runtime name"
        for f in ("formats", "quants", "adapters"):
            if f in r and (not isinstance(r[f], list) or len(r[f]) > 32
                           or any(not isinstance(v, str) or len(v) > 64 for v in r[f])):
                return "runtime " + f

    def ok(v):
        return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2 ** 53 - 1

    mem = body.get("mem")
    if not isinstance(mem, dict) or not ok(mem.get("ramTotalBytes")) or not ok(mem.get("ramAvailBytes")) \
            or mem["ramAvailBytes"] > mem["ramTotalBytes"]:
        return "mem"
    disk = body.get("disk")
    if not isinstance(disk, dict) or not ok(disk.get("totalBytes")) or not ok(disk.get("availBytes")) \
            or disk["availBytes"] > disk["totalBytes"]:
        return "disk"
    return None


class FakeApi:
    def __init__(self):
        self.calls = []  # (path, body, key) in arrival order
        self.caps_plan = []  # list of (status, body, retry_after)


def make_server(api):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body, retry_after=None):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode() or "{}")
            key = (self.headers.get("Authorization") or "").replace("Bearer ", "")
            api.calls.append((self.path, body, key))
            if self.path.endswith("/heartbeat"):
                self._send(200, {"ok": True, "heartbeatAt": "2026-11-03T00:00:00.000Z"})
            elif self.path.endswith("/capabilities"):
                if api.caps_plan:
                    status, payload, retry = api.caps_plan.pop(0)
                    self._send(status, payload, retry)
                elif server_accepts(body) is not None:
                    self._send(400, {"error": server_accepts(body), "code": "BAD_CAPABILITIES"})
                else:
                    self._send(200, {"ok": True, "nodeId": "r_fake01",
                                     "reportedAt": "2026-11-03T00:00:01.000Z", "schemaVersion": 1})
            else:
                self._send(404, {"error": "no", "code": "NOT_FOUND"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def write_config(directory, runtime_block, model_extra='path = "model.gguf"\n'):
    path = Path(directory) / "worker.toml"
    path.write_text(
        '[node]\nid = "cap-test"\nhost = "127.0.0.1"\nport = 8090\nstate_dir = "state"\n\n'
        + runtime_block
        + '\n[[models]]\nid = "m"\nruntime = "rt"\ncapabilities = ["summarize"]\n' + model_extra,
        encoding="utf-8")
    return path


class ReportShapeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_report_is_accepted_by_the_server_schema(self):
        with patch.object(pairing, "_memory_bytes", return_value=(16 * GIB, 6 * GIB)):
            report = build_capability_report(None, self.tmp.name)
        self.assertIsNone(server_accepts(report), report)
        self.assertEqual(report["schema_version"], 1)
        self.assertEqual(report["mem"], {"ramTotalBytes": 16 * GIB, "ramAvailBytes": 6 * GIB})
        self.assertLessEqual(report["disk"]["availBytes"], report["disk"]["totalBytes"])
        self.assertGreater(report["disk"]["totalBytes"], 0)

    def test_gpu_memory_is_never_guessed(self):
        with patch.object(pairing, "_memory_bytes", return_value=(8 * GIB, 2 * GIB)):
            report = build_capability_report(None, self.tmp.name)
        self.assertNotIn("gpu", report["mem"])
        self.assertNotIn("workload", report)

    def test_unmeasurable_memory_reports_nothing(self):
        with patch.object(pairing, "_memory_bytes", return_value=None):
            self.assertIsNone(build_capability_report(None, self.tmp.name))

    def test_unmeasurable_disk_reports_nothing(self):
        with patch.object(pairing, "_memory_bytes", return_value=(8 * GIB, 2 * GIB)), \
                patch.object(pairing, "_disk_bytes", return_value=None):
            self.assertIsNone(build_capability_report(None, self.tmp.name))

    def test_missing_psutil_is_unmeasurable_not_a_crash(self):
        with patch.dict(sys.modules, {"psutil": None}):
            self.assertIsNone(pairing._memory_bytes())

    def test_inconsistent_measurements_are_clamped_into_the_schema(self):
        with patch.object(pairing, "_memory_bytes", return_value=(4 * GIB, 9 * GIB)), \
                patch.object(pairing, "_disk_bytes", return_value=(2 ** 60, 2 ** 61)):
            report = build_capability_report(None, self.tmp.name)
        self.assertIsNone(server_accepts(report), report)
        self.assertEqual(report["mem"]["ramAvailBytes"], 4 * GIB)
        self.assertEqual(report["disk"]["totalBytes"], 2 ** 53 - 1)

    def test_no_config_claims_no_runtime(self):
        self.assertEqual(pairing._reportable_runtimes(None), [])
        self.assertEqual(pairing._reportable_runtimes(str(Path(self.tmp.name) / "absent.toml")), [])


@unittest.skipUnless(HAVE_DENDRITE, "installed worker (dendrite) not importable; run with the worker venv")
class RuntimeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_mock_runtime_is_not_capacity(self):
        self.assertEqual(pairing._reportable_runtimes(str(ROOT / "configs" / "mock.toml")), [])

    def test_managed_runtime_with_executable_on_path_is_reported(self):
        exe = Path(sys.executable).resolve()
        config = write_config(self.tmp.name, f'[[runtimes]]\nid = "rt"\nkind = "llama_cpp"\nmode = "managed"\n'
                                             f'executable = {json.dumps(str(exe))}\n')
        # Qualification lane: each entry carries its transport mode and the
        # stable configured model ids (from config only); readiness `models`
        # stay absent without a live probe.
        self.assertEqual(pairing._reportable_runtimes(str(config)),
                         [{"name": "llama-server", "mode": "managed", "formats": ["gguf"], "configured": ["m"]}])

    def assert_valid_config(self, config):
        # A config that fails to load would also claim nothing; prove these
        # "claims nothing" cases are refused for the stated reason instead.
        from dendrite.config import load_config
        self.assertTrue(load_config(Path(config)).runtimes)

    def test_managed_runtime_without_executable_claims_nothing(self):
        missing = str(Path(self.tmp.name) / "no-such-llama-server-binary")
        config = write_config(self.tmp.name, f'[[runtimes]]\nid = "rt"\nkind = "llama_cpp"\nmode = "managed"\n'
                                             f'executable = {json.dumps(missing)}\n')
        self.assert_valid_config(config)
        self.assertEqual(pairing._reportable_runtimes(str(config)), [])

    def test_attach_runtime_claims_nothing_without_a_live_probe(self):
        exe = Path(sys.executable).resolve()
        config = write_config(self.tmp.name, f'[[runtimes]]\nid = "rt"\nkind = "llama_cpp"\nmode = "attach"\n'
                                             f'executable = {json.dumps(str(exe))}\nbase_url = "http://127.0.0.1:8081"\n',
                              model_extra='upstream_model = "attached-model"\n')
        self.assert_valid_config(config)
        self.assertEqual(pairing._reportable_runtimes(str(config)), [])


class SendTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        self.server, self.base = make_server(self.api)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.report = {"schema_version": 1, "os": "Windows", "arch": "AMD64", "runtimes": [],
                       "mem": {"ramTotalBytes": 8 * GIB, "ramAvailBytes": 2 * GIB},
                       "disk": {"totalBytes": 100 * GIB, "availBytes": 40 * GIB}}

    def test_success_posts_report_with_bearer_to_resource_route(self):
        out = send_capabilities(self.base, "r_fake01", FAKE_SECRET, self.report)
        self.assertEqual(out["reportedAt"], "2026-11-03T00:00:01.000Z")
        path, body, key = self.api.calls[-1]
        self.assertEqual(path, "/api/resources/r_fake01/capabilities")
        self.assertEqual(body, self.report)
        self.assertEqual(key, FAKE_SECRET)

    def test_revoked_or_expired_key_demands_repair(self):
        for code in ("KEY_REVOKED", "KEY_EXPIRED"):
            self.api.caps_plan.append((401, {"error": "dead", "code": code}, None))
            with self.assertRaises(RePairRequired):
                send_capabilities(self.base, "r_fake01", FAKE_SECRET, self.report)

    def test_too_soon_carries_retry_after(self):
        self.api.caps_plan.append((429, {"error": "soon", "code": "CAPABILITIES_TOO_SOON", "retryAfterSec": 25}, 25))
        with self.assertRaises(PairingError) as ctx:
            send_capabilities(self.base, "r_fake01", FAKE_SECRET, self.report)
        self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.retry_after),
                         (429, "CAPABILITIES_TOO_SOON", 25))

    def test_schema_rejection_surfaces_its_code(self):
        self.api.caps_plan.append((400, {"error": "Unknown capability field rejected.", "code": "BAD_CAPABILITIES"}, None))
        with self.assertRaises(PairingError) as ctx:
            send_capabilities(self.base, "r_fake01", FAKE_SECRET, self.report)
        self.assertEqual(ctx.exception.code, "BAD_CAPABILITIES")


def beat_quantized_max_age(interval, target=None, beats=60):
    """Oldest a snapshot gets when reports ride successful beats.

    A report goes out on the first successful beat at or after each
    deadline; with no explicit target the sender's own scheduler
    (pairing.capability_period) sets the deadline.
    """
    if target is None:
        target = pairing.capability_period(interval)
    last, deadline, worst = 0.0, 0.0, 0.0
    for n in range(1, beats + 1):
        beat = n * interval
        if beat >= deadline:
            worst = max(worst, beat - last)
            last, deadline = beat, beat + target
    return worst


class SenderIntegrationTests(unittest.TestCase):
    """The opt-in report rides the heartbeat sender without ever hurting it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.api = FakeApi()
        self.server, self.base = make_server(self.api)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.meta = {"api_base": self.base, "resource_id": "r_fake01", "heartbeat_key": FAKE_SECRET}
        loader = patch.object(pairing, "load_pairing", return_value=self.meta)
        loader.start()
        self.addCleanup(loader.stop)
        status = patch.object(pairing, "write_status")
        status.start()
        self.addCleanup(status.stop)
        memory = patch.object(pairing, "_memory_bytes", return_value=(16 * GIB, 6 * GIB))
        memory.start()
        self.addCleanup(memory.stop)
        pairing.private_dir(self.data)

    def args(self, **kw):
        defaults = {"data_dir": str(self.data), "config": None, "interval": 60, "report_capabilities": False}
        defaults.update(kw)
        return type("Args", (), defaults)()

    def run_once(self, **kw):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cmd_heartbeat(self.args(**kw), loop=False)
        return code, out.getvalue(), err.getvalue()

    def paths(self):
        return [p.rsplit("/", 1)[-1] for p, _, _ in self.api.calls]

    def test_default_sender_sends_no_report(self):
        code, _, _ = self.run_once()
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(self.paths(), ["heartbeat"])

    def test_opt_in_reports_after_the_beat_never_before(self):
        code, out, _ = self.run_once(report_capabilities=True)
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(self.paths(), ["heartbeat", "capabilities"])
        self.assertIn("capabilities ok: runtimes=0", out)

    def test_report_failure_never_fails_the_heartbeat(self):
        for status in (500, 429, 400):
            self.api.calls.clear()
            self.api.caps_plan.append((status, {"error": "x", "code": "SOME_FAILURE"}, 30 if status == 429 else None))
            code, _, err = self.run_once(report_capabilities=True)
            self.assertEqual(code, EXIT_OK, status)
            self.assertIn("capabilities: [SOME_FAILURE]", err)
            self.assertEqual(self.paths(), ["heartbeat", "capabilities"])

    def test_unmeasurable_node_skips_report_and_keeps_beating(self):
        with patch.object(pairing, "_memory_bytes", return_value=None):
            code, _, err = self.run_once(report_capabilities=True)
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(self.paths(), ["heartbeat"])
        self.assertIn("not measurable", err)

    def test_step_schedules_retry_and_cadence(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.report_capabilities_step(self.meta, None, self.data, 60),
                             pairing.CAPABILITY_INTERVAL_SEC)
            self.api.caps_plan.append((429, {"error": "soon", "code": "CAPABILITIES_TOO_SOON"}, 5))
            self.assertEqual(pairing.report_capabilities_step(self.meta, None, self.data, 60),
                             pairing.HEARTBEAT_MIN_INTERVAL_SEC)
            self.api.caps_plan.append((503, {"error": "down", "code": "UNAVAILABLE"}, None))
            self.assertEqual(pairing.report_capabilities_step(self.meta, None, self.data, 60),
                             pairing.CAPABILITY_RETRY_SEC)

    def test_step_quantizes_the_cadence_to_the_beat_grid(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.report_capabilities_step(self.meta, None, self.data, 110), 220)
            self.assertEqual(pairing.report_capabilities_step(self.meta, None, self.data, 150), 150)

    def test_period_targets_the_latest_beat_inside_the_window(self):
        self.assertEqual(pairing.capability_period(60), 240)
        self.assertEqual(pairing.capability_period(30), 240)
        self.assertEqual(pairing.capability_period(110), 220)
        self.assertEqual(pairing.capability_period(150), 150)
        self.assertEqual(pairing.capability_period(240), 240)

    def test_coarse_beats_report_best_effort_and_are_unsupported(self):
        self.assertTrue(pairing.interval_supports_freshness(240))
        self.assertFalse(pairing.interval_supports_freshness(241))
        # Past the target no beat lands inside the window: report on the
        # next beat anyway rather than silently holding a stale snapshot.
        self.assertEqual(pairing.capability_period(300), 300)

    def test_cadence_stays_inside_the_catalog_freshness_window(self):
        # estimate.mjs TELEMETRY_FRESH_MS is 300s; a report must land before it.
        self.assertLessEqual(pairing.CAPABILITY_INTERVAL_SEC + pairing.HEARTBEAT_INTERVAL_SEC, 300)

    def test_110s_interval_report_stays_fresh(self):
        # Review follow-up: reports ride successful beats, so a fixed 240s
        # target overshoots to 330s on 110s beats — 30s past the 300s
        # catalog freshness window. The scheduler quantizes the deadline
        # to the beat grid instead (110s beats report every 220s).
        self.assertLessEqual(beat_quantized_max_age(110), 240)

    def test_every_supported_interval_holds_the_freshness_window(self):
        for interval in range(pairing.HEARTBEAT_MIN_INTERVAL_SEC, 241):
            self.assertLessEqual(
                beat_quantized_max_age(interval), 240,
                f"beat interval {interval}s lets a snapshot go stale")

    def test_output_never_contains_the_key(self):
        _, out, err = self.run_once(report_capabilities=True)
        self.assertNotIn(FAKE_SECRET, out + err)


class CliTests(unittest.TestCase):
    def test_dry_run_prints_a_valid_report_without_pairing_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            out, err = io.StringIO(), io.StringIO()
            with patch.object(pairing, "_memory_bytes", return_value=(16 * GIB, 6 * GIB)), \
                    patch.object(pairing, "post_json", side_effect=AssertionError("network used")), \
                    redirect_stdout(out), redirect_stderr(err):
                code = pairing.main(["--data-dir", tmp, "capabilities-once", "--dry-run"])
            self.assertEqual(code, EXIT_OK, err.getvalue())
            self.assertIsNone(server_accepts(json.loads(out.getvalue())))

    def test_unpaired_send_is_a_usage_error_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            err = io.StringIO()
            with redirect_stderr(err), redirect_stdout(io.StringIO()):
                code = pairing.main(["--data-dir", str(Path(tmp) / "d"), "capabilities-once"])
            self.assertNotEqual(code, EXIT_OK)
            self.assertIn("capabilities: [", err.getvalue())


BRIDGE = ROOT / ".." / "website" / "scripts" / "pairing-e2e-bridge.mjs"


def bridge_deps_present():
    return (BRIDGE.exists() and shutil.which("node")
            and (ROOT / ".." / "website" / "node_modules" / "better-auth").exists())


@unittest.skipUnless(bridge_deps_present(), "node or website/node_modules missing; cannot run E2E")
@unittest.skipUnless(HAVE_DENDRITE, "installed worker (dendrite/psutil) not importable; run with the worker venv")
class CapabilityE2ETests(unittest.TestCase):
    """Real pairing.py CLI -> real worker.js capability intake (in-memory D1)."""

    @classmethod
    def setUpClass(cls):
        from test_pairing_e2e import Bridge
        cls.bridge = Bridge()
        cls.addClassCleanup(cls.bridge.close)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)

    def cli(self, *args, data_dir):
        proc = subprocess.run([sys.executable, str(ROOT / "pairing.py"), "--api-base", self.bridge.base,
                               "--data-dir", str(data_dir), *args],
                              capture_output=True, text=True, timeout=60)
        return proc.returncode, proc.stdout, proc.stderr

    def test_paired_worker_report_is_stored_fresh_and_owner_readable(self):
        status, user = self.bridge.api("POST", "/__test/seed-user",
                                       {"email": "caps@example.test", "name": "Caps"})
        self.assertEqual(status, 200, user)
        owner = {"Cookie": user["cookie"], "X-Aipster-CSRF": "1"}
        status, minted = self.bridge.api("POST", "/api/pairing/codes", {}, owner)
        self.assertEqual(status, 201, minted)
        data_dir = Path(self.tmp.name) / f"caps-{time.time_ns()}"
        pairing.private_dir(data_dir)
        code, out, err = self.cli("pair", "--code", minted["code"], "--config",
                                  str(ROOT / "configs" / "mock.toml"), data_dir=data_dir)
        self.assertEqual(code, EXIT_OK, err)
        resource = json.loads((data_dir / "pairing.json").read_text())["resource_id"]

        # Before any report the catalog has nothing to evaluate.
        status, before = self.bridge.api("GET", f"/api/resources/{resource}/capabilities", None, owner)
        self.assertEqual((status, before.get("snapshot")), (200, None), before)

        code, out, err = self.cli("capabilities-once", "--config", str(ROOT / "configs" / "mock.toml"),
                                  data_dir=data_dir)
        self.assertEqual(code, EXIT_OK, err)
        self.assertIn("capabilities ok: runtimes=0", out)

        status, after = self.bridge.api("GET", f"/api/resources/{resource}/capabilities", None, owner)
        self.assertEqual(status, 200, after)
        snap = after["snapshot"]
        self.assertTrue(after["fresh"], after)
        self.assertEqual(snap["runtimes"], [])  # mock is not capacity
        self.assertGreater(snap["mem"]["ramTotalBytes"], 0)
        self.assertLessEqual(snap["mem"]["ramAvailBytes"], snap["mem"]["ramTotalBytes"])
        self.assertGreater(snap["disk"]["totalBytes"], 0)

        # An immediate second report is honestly throttled, not double-written.
        code, _, err = self.cli("capabilities-once", data_dir=data_dir)
        self.assertEqual(code, EXIT_NETWORK, err)
        self.assertIn("CAPABILITIES_TOO_SOON", err)

        # The worker never prints its key.
        secret = (data_dir / json.loads((data_dir / "pairing.json").read_text())["key_file"]).read_text().strip()
        self.assertNotIn(secret, out + err)


if __name__ == "__main__":
    unittest.main()
