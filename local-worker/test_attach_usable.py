"""Heartbeat usable bit for attach-mode runtimes (2026-11-03).

Before this change decide_usable() skipped every attach runtime, so a
paired worker attached to a healthy local llama.cpp server (JJP: tray
4c69689, llama-server on 127.0.0.1:8124) reported usable=false forever.
Readiness now comes from the running worker's authenticated loopback
GET /v1/node. These tests use a fake loopback node; no model is contacted.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing  # noqa: E402
from pairing import attached_ready_models, decide_usable  # noqa: E402

TOKEN = "test-token-not-a-secret"
MODEL = "qwen-test"
RUNTIME = "loopback-llama"


def node_report(**overrides):
    runtime = {"id": RUNTIME, "kind": "llama_cpp", "mode": "attach", "state": "ready",
               "busy": False, "simulated": False, "last_error": None}
    model = {"id": MODEL, "runtime": RUNTIME, "available": True, "resident": True,
             "simulated": False}
    runtime.update(overrides.pop("runtime", {}))
    model.update(overrides.pop("model", {}))
    report = {"runtimes": [{"id": "mock", "kind": "mock", "mode": "managed",
                            "state": "ready", "simulated": True}, runtime],
              "models": [{"id": "mock-summary", "runtime": "mock", "available": True,
                          "resident": True, "simulated": True}, model]}
    report.update(overrides)
    return report


class FakeNode:
    def __init__(self, status=200, body=None, location=None):
        self.status, self.body, self.location = status, body, location
        self.seen = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                fake.seen.append((self.path, self.headers.get("Authorization")))
                ok = self.headers.get("Authorization") == "Bearer " + TOKEN
                status = fake.status if ok else 401
                payload = fake.body if ok else {"error": "Invalid or missing Dendrite token"}
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                if fake.location:
                    self.send_header("Location", fake.location)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def write_config(directory, port, host="127.0.0.1", attach=True):
    runtime = (f'[[runtimes]]\nid = "{RUNTIME}"\nkind = "llama_cpp"\nmode = "attach"\n'
               f'base_url = "http://127.0.0.1:9"\n') if attach else \
              (f'[[runtimes]]\nid = "{RUNTIME}"\nkind = "llama_cpp"\n')
    text = (f'[node]\nid = "t"\nhost = "{host}"\nport = {port}\nstate_dir = "state"\n\n'
            '[[runtimes]]\nid = "mock"\nkind = "mock"\n\n'
            '[[models]]\nid = "mock-summary"\nruntime = "mock"\ncapabilities = ["summarize"]\n\n'
            f'{runtime}\n[[models]]\nid = "{MODEL}"\nruntime = "{RUNTIME}"\n'
            f'capabilities = ["completion"]\n' + (f'upstream_model = "{MODEL}"\n' if attach
                                              else 'path = "missing.gguf"\n'))
    path = Path(directory) / "config.toml"
    path.write_text(text, encoding="utf-8")
    return path


class AttachUsableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "api-token.txt").write_text(TOKEN + "\n", encoding="utf-8")
        env = patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DENDRITE_API_TOKEN", None)
        self.nodes = []

    def tearDown(self):
        for node in self.nodes:
            node.close()
        self.tmp.cleanup()

    def node(self, **kwargs):
        node = FakeNode(**kwargs)
        self.nodes.append(node)
        return node

    def test_ready_attached_model_is_usable(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port)
        self.assertTrue(decide_usable(str(config), self.data))
        self.assertEqual(node.seen, [("/v1/node", "Bearer " + TOKEN)])

    def test_token_env_takes_precedence(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port)
        (self.data / "api-token.txt").write_text("wrong\n", encoding="utf-8")
        with patch.dict(os.environ, {"DENDRITE_API_TOKEN": TOKEN}):
            self.assertTrue(decide_usable(str(config), self.data))

    def test_without_data_dir_or_token_stays_false(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port)
        self.assertFalse(decide_usable(str(config)))
        self.assertEqual(node.seen, [], "no token: the node is not even asked")

    def test_wrong_token_is_false(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port)
        (self.data / "api-token.txt").write_text("wrong\n", encoding="utf-8")
        self.assertFalse(decide_usable(str(config), self.data))

    def test_worker_down_is_false(self):
        node = self.node(body=node_report())
        port = node.port
        node.close()
        self.nodes.remove(node)
        config = write_config(self.data, port)
        self.assertFalse(decide_usable(str(config), self.data))

    def test_not_ready_shapes_are_false(self):
        cases = {
            "runtime starting": {"runtime": {"state": "starting"}},
            "runtime error": {"runtime": {"last_error": "upstream 500"}},
            "runtime simulated": {"runtime": {"simulated": True}},
            "runtime managed": {"runtime": {"mode": "managed"}},
            "model not resident": {"model": {"resident": False}},
            "model unavailable": {"model": {"available": False}},
            "model simulated": {"model": {"simulated": True}},
            "simulated truthy-not-false": {"model": {"simulated": None}},
            "other model id": {"model": {"id": "another-model"}},
        }
        for label, override in cases.items():
            with self.subTest(label):
                node = self.node(body=node_report(**override))
                config = write_config(self.data, node.port)
                self.assertFalse(decide_usable(str(config), self.data), label)

    def test_bad_responses_are_false(self):
        for label, kwargs in {
            "500": {"status": 500, "body": node_report()},
            "redirect": {"status": 302, "body": node_report(), "location": "http://127.0.0.1:9/"},
            "not json": {"body": b"<html>"},
            "list body": {"body": []},
            "missing keys": {"body": {}},
        }.items():
            with self.subTest(label):
                node = self.node(**kwargs)
                config = write_config(self.data, node.port)
                self.assertFalse(decide_usable(str(config), self.data), label)

    def test_mock_only_ready_node_is_still_false(self):
        node = self.node(body=node_report())
        path = self.data / "mock.toml"
        path.write_text(f'[node]\nid = "t"\nhost = "127.0.0.1"\nport = {node.port}\n'
                        'state_dir = "state"\n\n[[runtimes]]\nid = "mock"\nkind = "mock"\n\n'
                        '[[models]]\nid = "mock-summary"\nruntime = "mock"\n'
                        'capabilities = ["summarize"]\n', encoding="utf-8")
        self.assertFalse(decide_usable(str(path), self.data))
        self.assertEqual(node.seen, [])

    def test_managed_runtime_does_not_consult_node(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port, attach=False)
        self.assertFalse(decide_usable(str(config), self.data))
        self.assertEqual(node.seen, [], "managed readiness stays file+executable based")

    def test_non_loopback_listener_is_not_probed(self):
        from dendrite.config import load_config
        node = self.node(body=node_report())
        config = load_config(write_config(self.data, node.port))
        config.node.host = "192.0.2.10"
        self.assertEqual(attached_ready_models(config, self.data), set())
        self.assertEqual(node.seen, [])

    def test_malformed_types_never_raise(self):
        # These five shapes raised TypeError in 71e4695 (non-iterable lists,
        # unhashable ids), which would have killed the heartbeat sender.
        bodies = {
            "runtimes int": {"runtimes": 5, "models": []},
            "models int": {"runtimes": [], "models": 7},
            "runtimes bool": {"runtimes": True, "models": []},
            "runtimes str": {"runtimes": "abc", "models": "x"},
            "unhashable runtime id": {"runtimes": [{"id": ["x"]}], "models": []},
            "unhashable model runtime": node_report(models=[{"runtime": [RUNTIME], "id": MODEL}]),
            "unhashable model id": node_report(models=[{"runtime": RUNTIME, "id": {"a": 1},
                                                        "available": True, "resident": True,
                                                        "simulated": False}]),
            "null": None,
            "nested null": {"runtimes": [None], "models": [None]},
            "empty object": {},
            "empty lists": {"runtimes": [], "models": []},
        }
        for label, body in bodies.items():
            with self.subTest(label):
                node = self.node(body=json.dumps(body).encode())
                config = write_config(self.data, node.port)
                why = []
                self.assertFalse(decide_usable(str(config), self.data, why), label)
                self.assertEqual(len(why), 1)
                self.assertNotIn("error (", why[0], f"{label}: handled, not caught late")
                self.assertNotIn(TOKEN, why[0])

    def test_empty_and_oversized_bodies_are_false(self):
        for label, body, expect in [("empty", b"", "not JSON"),
                                    ("bad utf8", b"\xff\xfe", "not JSON"),
                                    ("oversized", b" " * (pairing.ATTACH_NODE_MAX_BYTES + 10),
                                     "too large")]:
            with self.subTest(label):
                node = self.node(body=body)
                config = write_config(self.data, node.port)
                why = []
                self.assertFalse(decide_usable(str(config), self.data, why))
                self.assertIn(expect, why[0])

    def test_reasons_are_specific(self):
        node = self.node(body=node_report(runtime={"state": "starting"}))
        config = write_config(self.data, node.port)
        why = []
        decide_usable(str(config), self.data, why)
        self.assertEqual(why, ["attach runtime not ready (state/error/simulated)"])
        node.body = node_report(model={"resident": False})
        why.clear()
        decide_usable(str(config), self.data, why)
        self.assertEqual(why, ["attach runtime ready but no model resident/available"])
        node.body = node_report()
        why.clear()
        self.assertTrue(decide_usable(str(config), self.data, why))
        self.assertEqual(why, [f"attach model ready: {RUNTIME}/{MODEL}"])

    def test_recovers_when_runtime_becomes_available(self):
        # Worker down -> worker up with runtime starting -> ready -> down again.
        down = self.node(body=node_report())
        port = down.port
        down.close()
        self.nodes.remove(down)
        config = write_config(self.data, port)
        why = []
        self.assertFalse(decide_usable(str(config), self.data, why))
        self.assertIn("unreachable", why[0])
        node = self.node(body=node_report(runtime={"state": "starting"}))
        config = write_config(self.data, node.port)
        self.assertFalse(decide_usable(str(config), self.data))
        node.body = node_report()
        self.assertTrue(decide_usable(str(config), self.data), "recovers without restart")
        node.body = node_report(runtime={"state": "failed", "last_error": "upstream gone"})
        self.assertFalse(decide_usable(str(config), self.data), "drops back immediately")

    def test_internal_errors_fail_closed(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port)
        with patch.object(pairing, "_attach_readiness", side_effect=RuntimeError("boom")):
            why = []
            self.assertFalse(decide_usable(str(config), self.data, why))
            self.assertEqual(why, ["attach probe error (RuntimeError)"])
        with patch.object(pairing, "_decide_usable", side_effect=TypeError("x")):
            why = []
            self.assertFalse(decide_usable(str(config), self.data, why))
            self.assertEqual(why, ["usable policy error (TypeError)"])

    def test_heartbeat_loop_passes_data_dir(self):
        source = (ROOT / "pairing.py").read_text(encoding="utf-8")
        self.assertIn("usable = decide_usable(args.config, data_dir, usable_why)", source)

    def test_capability_report_claims_verified_attach_runtime(self):
        node = self.node(body=node_report())
        config = write_config(self.data, node.port)
        self.assertEqual(pairing._reportable_runtimes(str(config), self.data),
                         [{"name": "llama-server", "formats": ["gguf"]}])
        report = pairing.build_capability_report(str(config), self.data)
        if report is not None:  # None only when psutil/disk cannot be measured
            self.assertEqual(report["runtimes"], [{"name": "llama-server", "formats": ["gguf"]}])

    def test_capability_report_drops_unready_or_unprobed_attach(self):
        node = self.node(body=node_report(runtime={"state": "unavailable"}))
        config = write_config(self.data, node.port)
        self.assertEqual(pairing._reportable_runtimes(str(config), self.data), [])
        node.body = node_report()
        self.assertEqual(pairing._reportable_runtimes(str(config)), [],
                         "no data dir and no token env: attach is never probed")
        self.assertEqual(len(node.seen), 1)
        node.body = b"{bad"
        self.assertEqual(pairing._reportable_runtimes(str(config), self.data), [])


def write_managed_config(directory, port):
    """Managed runtime whose model file (GGUF magic) and engine exist."""
    model = Path(directory) / "model.gguf"
    model.write_bytes(b"GGUF" + bytes(28))
    exe = Path(sys.executable).as_posix()
    text = "\n".join([
        "[node]", 'id = "t"', 'host = "127.0.0.1"', f"port = {port}", 'state_dir = "state"', "",
        "[[runtimes]]", f'id = "{RUNTIME}"', 'kind = "ik_llama"', f'executable = "{exe}"', "",
        "[[models]]", f'id = "{MODEL}"', f'runtime = "{RUNTIME}"',
        'capabilities = ["completion"]', f'path = "{model.as_posix()}"', ""])
    path = Path(directory) / "managed.toml"
    path.write_text(text, encoding="utf-8")
    return path


def managed_report(**overrides):
    runtime = {"id": RUNTIME, "kind": "ik_llama", "mode": "managed", "state": "unloaded",
               "busy": False, "simulated": False, "last_error": None}
    model = {"id": MODEL, "runtime": RUNTIME, "available": True, "resident": False,
             "simulated": False}
    runtime.update(overrides.pop("runtime", {}))
    model.update(overrides.pop("model", {}))
    return {"runtimes": [runtime], "models": [model]}


class ManagedLivenessTests(AttachUsableTests.__bases__[0]):
    """Managed usable also needs the worker daemon up (Mac 8aa6066a finding:
    usable=True for ~60 s while the daemon could not bind after a restart)."""

    setUp = AttachUsableTests.setUp
    tearDown = AttachUsableTests.tearDown
    node = AttachUsableTests.node

    def decide(self, config):
        why = []
        return decide_usable(str(config), self.data, why), why[0]

    def test_cold_managed_model_with_worker_up_is_usable(self):
        node = self.node(body=managed_report())
        usable, why = self.decide(write_managed_config(self.data, node.port))
        self.assertTrue(usable, why)
        self.assertEqual(why, f"managed model available: {RUNTIME}/{MODEL}")

    def test_worker_down_is_not_usable_even_with_files(self):
        node = self.node(body=managed_report())
        port = node.port
        node.close()
        self.nodes.remove(node)
        usable, why = self.decide(write_managed_config(self.data, port))
        self.assertFalse(usable)
        self.assertIn("unreachable", why)

    def test_unhealthy_reports_are_not_usable(self):
        for label, override in {
            "runtime error": {"runtime": {"state": "error"}},
            "runtime simulated": {"runtime": {"simulated": True}},
            "model unavailable": {"model": {"available": False}},
            "model simulated": {"model": {"simulated": None}},
            "other model": {"model": {"id": "other"}},
        }.items():
            with self.subTest(label):
                node = self.node(body=managed_report(**override))
                usable, why = self.decide(write_managed_config(self.data, node.port))
                self.assertFalse(usable, f"{label}: {why}")

    def test_missing_token_is_not_usable(self):
        node = self.node(body=managed_report())
        (self.data / "api-token.txt").unlink()
        usable, why = self.decide(write_managed_config(self.data, node.port))
        self.assertFalse(usable)
        self.assertIn("token unavailable", why)
        self.assertEqual(node.seen, [])

    def test_missing_files_never_probe(self):
        node = self.node(body=managed_report())
        config = write_managed_config(self.data, node.port)
        (self.data / "model.gguf").unlink()
        self.assertFalse(decide_usable(str(config), self.data))
        self.assertEqual(node.seen, [], "file/engine check still gates first")

if __name__ == "__main__":
    unittest.main()
