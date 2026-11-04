"""FABRIC067: tests for the worker model-readiness report helper (stdlib only).

Pure shaping tests: the helper performs no network calls and takes no
credentials, so the R1 redirect class cannot reappear here. No model is
contacted and no generation runs.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import model_readiness as mr  # noqa: E402


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

    def test_module_has_no_network_or_credential_surface(self):
        import ast
        import inspect
        tree = ast.parse(inspect.getsource(mr))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertTrue(imported.isdisjoint({"urllib", "socket", "http", "ssl"}))
        self.assertNotIn("collect_upstream_models", dir(mr))

    def test_runtime_entry_helper_never_maps_foreign_names(self):
        self.assertEqual(mr.runtime_models_entry("llama-server", ["m"]), {"models": ["m"]})
        self.assertEqual(mr.runtime_models_entry("cuda-thing", ["m"]), {})


if __name__ == "__main__":
    unittest.main()
