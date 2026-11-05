"""Focused serve-qualification runner tests (meta-qual lane). Fixtures only."""
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import pairing
from pairing import PairingError
from qual_runner import QualRunner, QualLedger, _validate_frame
import benchmark as bench
from benchmark import BenchmarkError
import qualification as qual

NOW = datetime(2026, 11, 5, 5, 0, 0, tzinfo=timezone.utc)
FUTURE = "2026-11-05T06:00:00.000Z"
META = {"api_base": "http://127.0.0.1:8471", "heartbeat_key": "k",
        "resource_id": "res1"}


def assignment(**over):
    base = {
        "runId": "qrun_1",
        "nodeId": "res1",
        "profileDigest": "a" * 64,
        "catalogVersion": "qual-catalog-v1",
        "catalogId": "completion-smoke-v1",
        "leaseId": "qlease_1",
        "deadlineAt": FUTURE,
        "runtimeAllowlist": ["ganglion"],
        "maxTokens": 32,
    }
    base.update(over)
    return base


def frame(**over):
    base = {"runId": "qrun_1", "leaseId": "qlease_1",
            "assignment": assignment(), "executionDeadline": FUTURE}
    base.update(over)
    return base


class Stubs:
    def __init__(self):
        self.posts = []
        self.benches = 0

    def post(self, base, run_id, secret, lease_id, status, result):
        self.posts.append({"run_id": run_id, "lease_id": lease_id,
                           "status": status, "result": result})

    def mem(self):
        return (8 << 30, 4 << 30)

    def bench(self, **kw):
        self.benches += 1
        return {"runtimeId": "ganglion", "modelId": "m", "elapsedMs": 9}


def fake_verify(**kw):
    return {"runtimeId": kw.get("runtime_id"), "modelId": kw.get("model_id"),
            "placement": "cpu", "mode": "attach"}


def runner(tmp, stubs, **over):
    kw = {"data_dir": tmp, "model_id": "m", "runtime_id": "ganglion",
          "ganglion_base": "http://127.0.0.1:8471",
          "sleep": lambda s: None, "now": lambda: NOW,
          "post_fn": stubs.post, "mem_fn": stubs.mem,
          "bench_fn": stubs.bench, "verify_fn": fake_verify}
    kw.update(over)
    runner = QualRunner(**kw)
    runner.ledger = QualLedger(tmp)
    return runner


class RunnerTest(unittest.TestCase):
    def test_poll_benchmark_post_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()
            r = runner(tmp, stubs)
            self.assertIsNone(r._handle(META, frame()))
            self.assertEqual(stubs.benches, 1)
            self.assertEqual(len(stubs.posts), 1)
            post = stubs.posts[0]
            self.assertEqual(post["run_id"], "qrun_1")
            self.assertEqual(post["lease_id"], "qlease_1")
            self.assertEqual(post["status"], "succeeded")
            self.assertTrue(r.ledger.contains("qrun_1"))

    def test_recorded_run_posts_uncertain_never_reruns(self):
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()
            r = runner(tmp, stubs)
            r._handle(META, frame())
            r._handle(META, frame())
            self.assertEqual(stubs.benches, 1)
            self.assertEqual(len(stubs.posts), 2)
            self.assertEqual(stubs.posts[1]["status"], "uncertain")
            self.assertEqual(stubs.posts[1]["result"]["reason"],
                             "UNCONFIRMED_PRIOR_RUN")

    def test_expired_execution_posts_timed_out_without_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()
            past = (NOW - timedelta(seconds=1)).isoformat()
            # Real boundary with no client: expiry precedes any upstream use.
            r = runner(tmp, stubs, bench_fn=bench.run_benchmark)
            r._handle(META, frame(executionDeadline=past))
            self.assertEqual(stubs.posts[-1]["status"], "timed_out")
            self.assertEqual(stubs.posts[-1]["result"]["reason"], "EXPIRED")

    def test_status_mapping(self):
        cases = [("SIMULATED", "unsupported"), ("MODEL_MISMATCH", "unsupported"),
                 ("NOT_READY", "unsupported"), ("MEMORY_UNVERIFIED", "unsupported"),
                 ("UPSTREAM_ERROR", "failed"), ("TIMED_OUT", "timed_out")]
        for reason, status in cases:
            with tempfile.TemporaryDirectory() as tmp, self.subTest(reason=reason):
                stubs = Stubs()

                def fail(**kw):
                    raise BenchmarkError(reason, "d")

                r = runner(tmp, stubs, bench_fn=fail)
                r._handle(META, frame())
                self.assertEqual(stubs.posts[0]["status"], status)
                self.assertEqual(stubs.posts[0]["result"]["reason"], reason)

    def test_invalid_frame_posts_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()
            r = runner(tmp, stubs)
            self.assertIsNone(r._handle(META, {"nope": True}))
            self.assertEqual(stubs.posts, [])
            self.assertEqual(stubs.benches, 0)

    def test_post_conflict_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()

            def conflict(*a):
                raise PairingError(409, "RESULT_REJECTED", "nope")

            r = runner(tmp, stubs, post_fn=conflict)
            self.assertIsNone(r._handle(META, frame()))
            self.assertEqual(stubs.benches, 1)

    def test_frame_validation(self):
        run_id, lease_id, assignment, exec_deadline = _validate_frame(frame())
        self.assertEqual((run_id, lease_id), ("qrun_1", "qlease_1"))
        self.assertEqual(exec_deadline, FUTURE)
        with self.assertRaises(qual.QualificationError):
            _validate_frame({"runId": "x"})

    def test_unverified_binding_posts_unsupported_without_bench(self):
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()

            def refuse(**kw):
                raise BenchmarkError("UNVERIFIED", "no worker config")

            r = runner(tmp, stubs, verify_fn=refuse)
            r._handle(META, frame())
            self.assertEqual(stubs.benches, 0)
            self.assertEqual(len(stubs.posts), 1)
            self.assertEqual(stubs.posts[0]["status"], "unsupported")
            self.assertEqual(stubs.posts[0]["result"]["reason"], "UNVERIFIED")
            self.assertFalse(r.ledger.contains("qrun_1"))

    def test_handle_forwards_native_identity_and_provenance(self):
        seen = {}

        def rec_bench(**kw):
            seen.update(kw)
            return {"runtimeId": "ganglion", "modelId": "m",
                    "servedModelId": "m-up",
                    "placementProvenance": "unknown", "elapsedMs": 9}

        def bound(**kw):
            return {"runtimeId": "ganglion", "modelId": "m",
                    "upstreamModel": "m-up",
                    "placementProvenance": "unknown", "mode": "attach"}

        with tempfile.TemporaryDirectory() as tmp:
            stubs = Stubs()
            r = runner(tmp, stubs, bench_fn=rec_bench, verify_fn=bound)
            r._handle(META, frame())
            self.assertEqual(seen.get("upstream_model"), "m-up")
            self.assertEqual(seen.get("placement_provenance"), "unknown")
            self.assertEqual(stubs.posts[0]["status"], "succeeded")
            self.assertEqual(stubs.posts[0]["result"]["servedModelId"], "m-up")

    def test_pairing_hook_lazy_no_new_credentials(self):
        import subprocess
        # A fresh interpreter importing only pairing must not pull the
        # benchmark runner (lazy opt-in), and the hook takes no memory or
        # credential flags: identity is the stored heartbeat pairing.
        code = ("import sys, pairing; "
                "assert 'qual_runner' not in sys.modules, 'eager import'; "
                "args = pairing.build_parser().parse_args("
                "['serve-qualification', '--model-id', 'm']); "
                "assert args.model_id == 'm'; "
                "assert not hasattr(args, 'mem_total_bytes'); "
                "assert not hasattr(args, 'mem_avail_bytes'); "
                "print('hook ok')")
        proc = subprocess.run([sys.executable, "-c", code],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("hook ok", proc.stdout)


def _ns(tree):
    """SimpleNamespace view of parsed TOML using only real schema keys."""
    import types
    if isinstance(tree, dict):
        return types.SimpleNamespace(
            **{k: _ns(v) for k, v in tree.items()})
    if isinstance(tree, list):
        return [_ns(v) for v in tree]
    return tree


ATTACH_TOML = """
[node]
id = "qnode"
host = "127.0.0.1"
port = 8090
state_dir = "../.state"

[[runtimes]]
id = "g0"
kind = "llama_cpp"
mode = "attach"
base_url = "http://127.0.0.1:8471"
gpu_layers = 0

[[models]]
id = "m"
runtime = "g0"
capabilities = ["summarize"]
upstream_model = "m-up"
"""

MANAGED_TOML = """
[node]
id = "qnode"
host = "127.0.0.1"
port = 8090
state_dir = "../.state"

[[runtimes]]
id = "cpu"
kind = "llama_cpp"
mode = "managed"
executable = "llama-server"
port = 8081
context_size = 2048
threads = 2
gpu_layers = 0

[[models]]
id = "m"
runtime = "cpu"
capabilities = ["summarize"]
path = "../models/m.gguf"
"""


def toml_config(text):
    import tomllib
    doc = tomllib.loads(text)
    return _ns(doc)


class BindingTest(unittest.TestCase):
    def check(self, text, runtime_id="ganglion", model_id="m",
              base="http://127.0.0.1:8471",
              attach_ready=None, managed_ready=None, which=None,
              attach_probe=None, managed_probe=None):
        from qual_runner import verify_local_binding
        return verify_local_binding(
            config_path="cfg", data_dir="dd", runtime_id=runtime_id,
            model_id=model_id, ganglion_base=base,
            load_config=lambda p: toml_config(text),
            attach_probe=attach_probe or (lambda c, d, t: (attach_ready or set(), "t")),
            managed_probe=managed_probe or (lambda c, d, t: (managed_ready or set(), "t")),
            which=which or (lambda exe: "/bin/" + exe if exe else None))

    def test_attach_binding_happy(self):
        out = self.check(ATTACH_TOML, attach_ready={("g0", "m")})
        self.assertEqual(out["upstreamModel"], "m-up")
        self.assertEqual(out["placementProvenance"], "operator-declared")
        self.assertEqual(out["configRuntime"], "g0")
        self.assertEqual(out["endpoint"], "http://127.0.0.1:8471")
        self.assertNotIn("placement", out,
                         "provenance travels, never a placement certificate")

    def test_attach_target_must_be_the_runtime_endpoint(self):
        # An unrelated loopback proxy is refused even though it is local.
        with self.assertRaises(BenchmarkError) as ctx:
            self.check(ATTACH_TOML, base="http://127.0.0.1:9999",
                       attach_ready={("g0", "m")})
        self.assertEqual(ctx.exception.reason, "BINDING_MISMATCH")

    def test_managed_execution_is_explicitly_deferred(self):
        # A worker-spawned engine serves a native alias the runner cannot
        # yet map to the configured id, so managed never executes: explicit
        # unsupported before any probe, endpoint, or executable check.
        probes = []

        def _boom(config, data_dir, timeout):
            probes.append((config, data_dir, timeout))
            raise AssertionError("deferred managed must not probe")

        with self.assertRaises(BenchmarkError) as ctx:
            self.check(MANAGED_TOML, runtime_id="llama-server", model_id="m",
                       base="http://127.0.0.1:8081",
                       managed_ready={("cpu", "m")},
                       attach_probe=_boom, managed_probe=_boom)
        self.assertEqual(ctx.exception.reason, "MANAGED_DEFERRED")
        self.assertEqual(probes, [])

    def test_mock_unconfigured_or_aliasless_refused(self):
        for text in (ATTACH_TOML.replace('kind = "llama_cpp"',
                                         'kind = "mock"'),
                     ATTACH_TOML.replace('id = "m"', 'id = "other"'),
                     ATTACH_TOML.replace('upstream_model = "m-up"\n', '')):
            with self.assertRaises(BenchmarkError) as ctx:
                self.check(text, attach_ready={("g0", "m")})
            self.assertEqual(ctx.exception.reason, "UNVERIFIED")

    def test_attach_placement_is_provenance_never_gate_or_certificate(self):
        # Absent pin binds as unknown; explicit zero reads operator-declared;
        # even a nonzero pin binds (unknown) — attach placement is recorded,
        # never certified and never gating.
        stripped = "\n".join(ln for ln in ATTACH_TOML.splitlines()
                             if "gpu_layers" not in ln)
        out = self.check(stripped, attach_ready={("g0", "m")})
        self.assertEqual(out["placementProvenance"], "unknown")
        self.assertEqual(out["upstreamModel"], "m-up")
        out = self.check(ATTACH_TOML.replace("gpu_layers = 0",
                                             "gpu_layers = 7"),
                         attach_ready={("g0", "m")})
        self.assertEqual(out["placementProvenance"], "unknown")

    def test_bool_placement_is_not_an_explicit_pin(self):
        # A bool is not an explicit zero pin, so provenance reads unknown —
        # and attach binds anyway, because placement never gates attach.
        out = self.check(ATTACH_TOML.replace("gpu_layers = 0",
                                             "gpu_layers = false"),
                         attach_ready={("g0", "m")})
        self.assertEqual(out["placementProvenance"], "unknown")

    def test_explicit_pins_read_raw_toml_only(self):
        import os
        from qual_runner import _explicit_cpu_pins
        doc = ('[[runtimes]]\nid = "a"\nkind = "llama_cpp"\nmode = "attach"\n'
               'base_url = "http://127.0.0.1:8124"\ngpu_layers = 0\n'
               '[[runtimes]]\nid = "b"\nkind = "llama_cpp"\nmode = "managed"\n'
               '[[runtimes]]\nid = "c"\nkind = "llama_cpp"\nmode = "managed"\n'
               'gpu_layers = 2\n')
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.toml")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(doc)
            self.assertEqual(_explicit_cpu_pins(path), {"a"})
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("not toml [[[\n")
            with self.assertRaises(BenchmarkError) as ctx:
                _explicit_cpu_pins(path)
            self.assertEqual(ctx.exception.reason, "UNVERIFIED")
            with self.assertRaises(BenchmarkError) as ctx:
                _explicit_cpu_pins(os.path.join(tmp, "missing.toml"))
            self.assertEqual(ctx.exception.reason, "UNVERIFIED")

    def test_probe_not_ready_is_not_ready(self):
        with self.assertRaises(BenchmarkError) as ctx:
            self.check(ATTACH_TOML)
        self.assertEqual(ctx.exception.reason, "NOT_READY")

    def test_no_config_or_bad_transport_unverified(self):
        from qual_runner import verify_local_binding
        with self.assertRaises(BenchmarkError):
            verify_local_binding(config_path=None, data_dir="d",
                                 runtime_id="ganglion", model_id="m",
                                 ganglion_base="http://127.0.0.1:8471")
        with self.assertRaises(BenchmarkError):
            verify_local_binding(config_path="c", data_dir="d",
                                 runtime_id="cuda", model_id="m",
                                 ganglion_base="http://127.0.0.1:8471")


try:
    import pydantic  # noqa: F401  (real dendrite loader needs it)
    _HAS_PYDANTIC = True
except ImportError:
    _HAS_PYDANTIC = False

# Sanitized mirror of an installed-worker attach config: real schema keys,
# real loopback shape, model identity as configured — with gpu_layers left
# absent exactly as found, so the production loader default-fills it.
REALISTIC_ATTACH_TOML = """
[node]
id = "qnode"
host = "127.0.0.1"
port = 8090
state_dir = ".state"

[[runtimes]]
id = "loopback-llama-8124"
kind = "llama_cpp"
mode = "attach"
base_url = "http://127.0.0.1:8124"

[[models]]
id = "qwen3.8-27b-atx-iq4_xs"
runtime = "loopback-llama-8124"
capabilities = ["completion"]
upstream_model = "qwen3.8-27b-atx-iq4_xs"
"""


@unittest.skipUnless(_HAS_PYDANTIC, "real dendrite loader needs pydantic")
class RealLoaderBindingTest(unittest.TestCase):
    """Production-loader path: attach placement is provenance, not a gate.

    Uses the REAL vendored loader (no injected config doubles) against real
    TOML files, so a default-filled gpu_layers binds as 'unknown' (never a
    CPU certificate) while an explicit pin binds as 'operator-declared'.
    Managed stays explicitly deferred. Probes stay injected: no network, no
    daemon.
    """

    def setUp(self):
        import os
        here = os.path.dirname(os.path.abspath(__file__))
        vendored = os.path.join(here, "vendor", "eif")
        if vendored not in sys.path:
            sys.path.insert(0, vendored)

    def write_toml(self, tmp, text):
        import os
        path = os.path.join(tmp, "config.toml")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def check_real(self, path, runtime_id, model_id, base, ready):
        from qual_runner import verify_local_binding
        calls = []

        def probe(config, data_dir, timeout):
            calls.append((config, data_dir, timeout))
            return (ready, "test probe")

        return calls, verify_local_binding(
            config_path=path, data_dir="dd", runtime_id=runtime_id,
            model_id=model_id, ganglion_base=base,
            attach_probe=probe, managed_probe=probe,
            which=lambda exe: "/bin/" + exe if exe else None)

    def test_realistic_unpinned_attach_binds_as_unknown(self):
        # The installed-worker shape (no gpu_layers pin): the production
        # loader default-fills 0, but the bind records 'unknown' — usable
        # for the generic smoke, never a CPU certificate.
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_toml(tmp, REALISTIC_ATTACH_TOML)
            calls, out = self.check_real(
                path, "ganglion", "qwen3.8-27b-atx-iq4_xs",
                "http://127.0.0.1:8124",
                {("loopback-llama-8124", "qwen3.8-27b-atx-iq4_xs")})
            self.assertEqual(out["upstreamModel"], "qwen3.8-27b-atx-iq4_xs")
            self.assertEqual(out["placementProvenance"], "unknown")
            self.assertEqual(out["configRuntime"], "loopback-llama-8124")
            self.assertEqual(out["endpoint"], "http://127.0.0.1:8124")
            self.assertNotIn("placement", out)
            self.assertTrue(calls, "readiness probe still gates the bind")

    def test_explicit_pin_binds_through_real_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = REALISTIC_ATTACH_TOML.replace(
                'base_url = "http://127.0.0.1:8124"',
                'base_url = "http://127.0.0.1:8124"\ngpu_layers = 0')
            path = self.write_toml(tmp, text)
            calls, out = self.check_real(
                path, "ganglion", "qwen3.8-27b-atx-iq4_xs",
                "http://127.0.0.1:8124",
                {("loopback-llama-8124", "qwen3.8-27b-atx-iq4_xs")})
            self.assertEqual(out["placementProvenance"], "operator-declared")
            self.assertEqual(out["configRuntime"], "loopback-llama-8124")
            self.assertEqual(out["endpoint"], "http://127.0.0.1:8124")
            self.assertTrue(calls, "readiness probe still gates the bind")

    def test_managed_defers_through_real_loader(self):
        from benchmark import BenchmarkError
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_toml(tmp, MANAGED_TOML)
            with self.assertRaises(BenchmarkError) as ctx:
                self.check_real(path, "llama-server", "m",
                                "http://127.0.0.1:8081", {("cpu", "m")})
            self.assertEqual(ctx.exception.reason, "MANAGED_DEFERRED")


if __name__ == "__main__":
    unittest.main()
