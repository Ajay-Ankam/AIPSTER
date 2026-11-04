"""WEB068: report-side wiring tests for worker capability model attachment.

Tests pairing._reportable_runtimes' models attachment against the real
pairing code and the real model_readiness helper. The installed ``dendrite``
worker package is absent on this box (and the attach probe needs a running
worker), so both dependency seams are substituted with documented fixtures:

* sys.modules["dendrite.config"]: stub load_config returning a synthetic
  parsed config shaped like the real loader output (mirrors the existing
  lane convention of skipping honestly when dendrite is absent, except here
  the loader seam is small enough to stub exactly instead of skipping).
* pairing.attach_readiness: patched to return a fixed (ready, reason) pair.

Nothing here touches a real worker, real config file contents beyond the
synthetic TOML text, or the network. Fixture node/runtime/model ids only.
"""
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing

FIXTURE_NODE_ID = "site068-fixture-node"
FIXTURE_RUNTIME_ID = "fixture-rt"
FIXTURE_MODEL = "synthetic-Qwen3-0.6B-Q8_0.gguf"


def _synthetic_config(runtimes):
    return SimpleNamespace(node=SimpleNamespace(id=FIXTURE_NODE_ID), runtimes=runtimes)


def _attach_runtime(runtime_id=FIXTURE_RUNTIME_ID):
    return SimpleNamespace(id=runtime_id, kind="llama_cpp", mode="attach",
                           executable=None)


def _managed_runtime(runtime_id="fixture-managed", present=True):
    exe = "python" if present else "definitely-not-on-path-xyz"
    return SimpleNamespace(id=runtime_id, kind="llama_cpp", mode="managed",
                           executable=exe)


def _install_dendrite_stub(config):
    """Inject a stub dendrite.config whose load_config returns `config`."""
    stub = types.ModuleType("dendrite.config")
    stub.load_config = lambda _path: config  # noqa: E731 - fixture seam
    package = types.ModuleType("dendrite")
    package.config = stub
    sys.modules["dendrite"] = package
    sys.modules["dendrite.config"] = stub


def _remove_dendrite_stub():
    sys.modules.pop("dendrite", None)
    sys.modules.pop("dendrite.config", None)


class ReportableRuntimesModelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="site068-report-")
        self.cfg_path = str(Path(self.tmp) / "config.toml")
        Path(self.cfg_path).write_text("# synthetic fixture config (contents unused by stub)\n",
                                       encoding="utf-8")

    def _report(self, config, pairs):
        _install_dendrite_stub(config)
        try:
            with patch.object(pairing, "attach_readiness",
                              return_value=(set(pairs), "fixture")):
                return pairing._reportable_runtimes(self.cfg_path, self.tmp)
        finally:
            _remove_dendrite_stub()

    def test_attach_verified_attaches_models(self):
        found = self._report(_synthetic_config([_attach_runtime()]),
                             {(FIXTURE_RUNTIME_ID, FIXTURE_MODEL)})
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["models"], [FIXTURE_MODEL])

    def test_unready_attach_runtime_is_omitted(self):
        found = self._report(_synthetic_config([_attach_runtime()]), set())
        self.assertEqual(found, [])

    def test_managed_runtime_gets_no_models_key(self):
        found = self._report(_synthetic_config([_managed_runtime()]), set())
        self.assertEqual(len(found), 1)
        self.assertNotIn("models", found[0])

    def test_missing_helper_keeps_report_model_less(self):
        real_import = __import__

        def sabotage(name, *args, **kwargs):
            if name == "model_readiness":
                raise ImportError("synthetic missing helper")
            return real_import(name, *args, **kwargs)

        _install_dendrite_stub(_synthetic_config([_attach_runtime()]))
        try:
            with patch.object(pairing, "attach_readiness",
                              return_value=({(FIXTURE_RUNTIME_ID, FIXTURE_MODEL)},
                                            "fixture")), \
                 patch("builtins.__import__", side_effect=sabotage):
                found = pairing._reportable_runtimes(self.cfg_path, self.tmp)
        finally:
            _remove_dendrite_stub()
        self.assertEqual(len(found), 1)
        self.assertNotIn("models", found[0])


if __name__ == "__main__":
    unittest.main()
