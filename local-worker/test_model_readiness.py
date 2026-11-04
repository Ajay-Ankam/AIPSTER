"""FABRIC067: tests for the worker model-readiness report helper (stdlib only).

Synthetic local HTTP only for the integeration-free collection parse; no
model is contacted and no generation runs.
"""

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import model_readiness as mr  # noqa: E402


class ModelsHandler(BaseHTTPRequestHandler):
    payload = {"object": "list", "data": [{"id": "qwen3-synth"}, {"id": "other-synth"}]}

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):  # noqa: N802
        assert self.path == "/v1/models", self.path
        data = json.dumps(ModelsHandler.payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class HelperCase(unittest.TestCase):
    def test_builds_typed_evidence(self):
        ev = mr.build_model_evidence(["qwen3-synth", "other-synth"], "llama-server", now_ms=1700000000000)
        self.assertEqual(ev, {"schema": "aipster-model-readiness/1", "runtime_id": "llama-server",
                              "observed_at_ms": 1700000000000,
                              "models": [{"model_id": "qwen3-synth", "ready": True},
                                         {"model_id": "other-synth", "ready": True}]})

    def test_rejects_foreign_runtime_and_bad_ids(self):
        with self.assertRaises(mr.ReadinessError):
            mr.build_model_evidence(["m"], "cuda-native", now_ms=1)
        with self.assertRaises(mr.ReadinessError):
            mr.build_model_evidence([""], "ganglion", now_ms=1)
        with self.assertRaises(mr.ReadinessError):
            mr.build_model_evidence(["x" * 257], "ganglion", now_ms=1)
        with self.assertRaises(mr.ReadinessError):
            mr.build_model_evidence(["m%d" % i for i in range(65)], "ganglion", now_ms=1)
        ev = mr.build_model_evidence(["b", "a", "b"], "ganglion", now_ms=1)
        self.assertEqual([m["model_id"] for m in ev["models"]], ["b", "a"])

    def test_upstream_base_gate_never_dials(self):
        for bad in ("http://192.168.1.9:8124", "http://user@127.0.0.1:8124",
                    "ftp://127.0.0.1/x", "", "http://127.0.0.1:8124/?x=1"):
            with self.assertRaises(mr.ReadinessError, msg=bad):
                mr.check_upstream_base(bad)
        self.assertTrue(mr.check_upstream_base("http://127.0.0.1:8124").endswith(":8124"))

    def test_collects_listed_ids_from_fixture_upstream(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), ModelsHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            ids = mr.collect_upstream_models("http://127.0.0.1:%d" % server.server_port, timeout=5)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(ids, ["qwen3-synth", "other-synth"])

    def test_collection_failure_is_never_readiness(self):
        with self.assertRaises(mr.ReadinessError):
            mr.collect_upstream_models("http://127.0.0.1:9", timeout=2)

    def test_runtime_entry_helper_never_maps_foreign_names(self):
        self.assertEqual(mr.runtime_models_entry("llama-server", ["m"]), {"models": ["m"]})
        self.assertEqual(mr.runtime_models_entry("cuda-thing", ["m"]), {})


if __name__ == "__main__":
    unittest.main()
