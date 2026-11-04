"""Attach readiness against the REAL vendored dendrite /v1/node contract.

The worker app (dendrite.api.create_app) runs in-process on an ephemeral
loopback port as a test fixture, attached to a fake llama.cpp server whose
/health and /v1/models answers the test switches. No real model, no
installed worker and no fixed port are touched.
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing  # noqa: E402
from pairing import decide_usable  # noqa: E402

TOKEN = "contract-token-not-a-secret-0123456789abcdef"
UPSTREAM = "qwen-upstream"


class FakeLlama:
    """Minimal llama.cpp attach surface: /health and /v1/models."""

    def __init__(self, port=0):
        self.mode = "ok"  # ok | loading | wrong-model | bad-json | down
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                mode = fake.mode
                if self.path == "/health":
                    status, body = ((503, {"error": {"message": "Loading model"}})
                                    if mode == "loading" else (200, {"status": "ok"}))
                elif self.path == "/v1/models":
                    if mode == "bad-json":
                        status, body = 200, b"{not json"
                    else:
                        model = "other-model" if mode == "wrong-model" else UPSTREAM
                        status, body = 200, {"object": "list", "data": [{"id": model}]}
                else:
                    status, body = 404, {"error": "not found"}
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def free_port():
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class DendriteContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import uvicorn  # noqa: F401
            from dendrite.api import create_app  # noqa: F401
            from dendrite.config import load_config  # noqa: F401
        except ImportError as exc:  # pragma: no cover - environment without worker deps
            raise unittest.SkipTest(f"worker dependencies unavailable: {exc}")

    def setUp(self):
        import uvicorn
        from dendrite.api import create_app
        from dendrite.config import load_config

        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        (self.data / "api-token.txt").write_text(TOKEN + "\n", encoding="utf-8")
        self.llama = FakeLlama()
        self.port = free_port()
        self.config_path = self.data / "config.toml"
        self.config_path.write_text(self.config_text(), encoding="utf-8")
        env = patch.dict(os.environ, {"DENDRITE_API_TOKEN": TOKEN})
        env.start()
        self.addCleanup(env.stop)
        app = create_app(load_config(self.config_path))
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port,
                                                    log_level="error", lifespan="on"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 15
        while not self.server.started:
            if time.monotonic() > deadline:
                self.fail("dendrite test app did not start")
            time.sleep(0.05)
        # The sender reads the token from the data dir, not the env.
        os.environ.pop("DENDRITE_API_TOKEN", None)

    def config_text(self):
        return "\n".join([
            "[node]", 'id = "contract"', 'host = "127.0.0.1"', f"port = {self.port}",
            f'state_dir = "{(self.data / "state").as_posix()}"', "",
            "[[runtimes]]", 'id = "mock"', 'kind = "mock"', "",
            "[[models]]", 'id = "mock-summary"', 'runtime = "mock"', 'capabilities = ["summarize"]', "",
            "[[runtimes]]", 'id = "attached"', 'kind = "llama_cpp"', 'mode = "attach"',
            f'base_url = "http://127.0.0.1:{self.llama.port}"', "",
            "[[models]]", 'id = "qwen"', 'runtime = "attached"', 'capabilities = ["completion"]',
            f'upstream_model = "{UPSTREAM}"', ""])

    def tearDown(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)
        self.llama.close()
        self.tmp.cleanup()

    def decide(self):
        why = []
        return decide_usable(str(self.config_path), self.data, why), why[0]

    def test_healthy_attached_model_is_usable(self):
        usable, why = self.decide()
        self.assertTrue(usable, why)
        self.assertEqual(why, "attach model ready: attached/qwen")

    def test_unavailable_states_then_recovery(self):
        for mode in ("loading", "wrong-model", "bad-json"):
            with self.subTest(mode):
                self.llama.mode = mode
                usable, why = self.decide()
                self.assertFalse(usable, f"{mode}: {why}")
                self.assertIn("not ready", why)
        self.llama.mode = "ok"
        usable, why = self.decide()
        self.assertTrue(usable, f"recovery: {why}")

    def test_llama_down_then_recovery(self):
        port = self.llama.port
        self.llama.close()
        usable, why = self.decide()
        self.assertFalse(usable, why)
        self.assertIn("not ready", why)
        # Bring a runtime back on the same port: readiness recovers on the next beat.
        for _ in range(20):
            try:
                self.llama = FakeLlama(port)
                break
            except OSError:
                time.sleep(0.1)
        else:
            self.skipTest("could not rebind the fake runtime port")
        usable, why = self.decide()
        self.assertTrue(usable, f"recovery: {why}")

    def test_worker_down_is_false(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)
        usable, why = self.decide()
        self.assertFalse(usable)
        self.assertIn("unreachable", why)



class ManagedDendriteContractTests(DendriteContractTests):
    """Managed usable needs the real worker up, not just files on disk."""

    def config_text(self):
        model = self.data / "model.gguf"
        model.write_bytes(b"GGUF" + bytes(28))
        exe = Path(sys.executable).as_posix()
        return "\n".join([
            "[node]", 'id = "contract"', 'host = "127.0.0.1"', f"port = {self.port}",
            f'state_dir = "{(self.data / "state").as_posix()}"', "",
            "[[runtimes]]", 'id = "cpu"', 'kind = "ik_llama"', f'executable = "{exe}"', "",
            "[[models]]", 'id = "small"', 'runtime = "cpu"', 'capabilities = ["completion"]',
            f'path = "{model.as_posix()}"', ""])

    def test_healthy_attached_model_is_usable(self):
        usable, why = self.decide()
        self.assertTrue(usable, why)
        self.assertEqual(why, "managed model available: cpu/small")

    def test_unavailable_states_then_recovery(self):
        (self.data / "model.gguf").write_bytes(b"NOPE" + bytes(28))
        usable, why = self.decide()
        self.assertFalse(usable, why)
        (self.data / "model.gguf").write_bytes(b"GGUF" + bytes(28))
        usable, why = self.decide()
        self.assertTrue(usable, f"recovery: {why}")

    def test_llama_down_then_recovery(self):
        # Managed analogue of "engine down": the model file disappears while
        # the worker stays up. The worker's own model_available check makes
        # it unusable, and it recovers when the file is restored.
        model = self.data / "model.gguf"
        saved = model.read_bytes()
        model.unlink()
        usable, why = self.decide()
        self.assertFalse(usable, why)
        model.write_bytes(saved)
        usable, why = self.decide()
        self.assertTrue(usable, f"recovery: {why}")

if __name__ == "__main__":
    unittest.main()
