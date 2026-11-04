"""FABRIC067: tests for the loopback fabric OpenAI proxy (stdlib only).

Real HTTP protocol against a local fixture fabric entrypoint; no model is
contacted and no generation runs. The fixture stands in for the trusted
fabric origin only. Cases: bounded validation, honest stream/tool refusal,
fixed-origin SSRF guard, user-key authority (heartbeat key never accepted),
fabric-down 503 with no direct-runtime fallback, Host/query guards, and key
redaction in logs and responses.

Run:  python -m pytest test_fabric_openai_proxy.py -q
"""

import io
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import fabric_openai_proxy as proxy  # noqa: E402


class FixtureFabricHandler(BaseHTTPRequestHandler):
    """Minimal trusted-origin stand-in: records auth + payload, answers compat."""

    seen = []
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        FixtureFabricHandler.seen.append(("GET", self.path, self.headers.get("Authorization")))
        self._send(200, {"object": "list", "data": [{"id": "qwen3-fixture", "object": "model"}]})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length).decode())
        FixtureFabricHandler.seen.append(("POST", self.path, self.headers.get("Authorization"), payload))
        self._send(200, {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1700000000,
                         "model": payload["model"],
                         "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                                      "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}})


def start_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return server


def post(port, path, obj, extra_headers=None):
    req = Request("http://127.0.0.1:%d%s" % (port, path),
                  data=json.dumps(obj).encode(), headers={"Content-Type": "application/json",
                                                           **(extra_headers or {})}, method="POST")
    try:
        with urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except Exception as exc:
        return int(exc.status), json.loads(exc.read().decode())


def get(port, path):
    try:
        with urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except Exception as exc:
        return int(exc.status), json.loads(exc.read().decode())


class ProxyCase(unittest.TestCase):
    def setUp(self):
        FixtureFabricHandler.seen = []
        self.fabric = start_server(FixtureFabricHandler)
        fabric_port = self.fabric.server_port
        self.origin = "http://127.0.0.1:%d" % fabric_port
        self.server = start_server(proxy.FabricOpenAIProxyHandler)
        proxy.FabricOpenAIProxyHandler.fabric_origin = self.origin
        proxy.FabricOpenAIProxyHandler.api_key_env = "FABRIC067_TEST_KEY"
        proxy.FabricOpenAIProxyHandler.timeout = 10.0
        self.port = self.server.server_port
        os.environ["FABRIC067_TEST_KEY"] = "user-key-not-a-secret"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.fabric.shutdown()
        self.fabric.server_close()
        os.environ.pop("FABRIC067_TEST_KEY", None)

    def test_models_passthrough_advertises_fabric_models(self):
        status, body = get(self.port, "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(body["data"][0]["id"], "qwen3-fixture")
        method, path, auth = FixtureFabricHandler.seen[0]
        self.assertEqual((method, path), ("GET", "/v1/models"))
        self.assertEqual(auth, "Bearer user-key-not-a-secret")

    def test_chat_validates_bounds_then_forwards_with_user_key(self):
        status, body = post(self.port, "/v1/chat/completions",
                            {"model": "auto", "messages": [{"role": "user", "content": "Say ok"}], "max_tokens": 16})
        self.assertEqual(status, 200)
        self.assertEqual(body["object"], "chat.completion")
        method, path, auth, payload = FixtureFabricHandler.seen[0]
        self.assertEqual(auth, "Bearer user-key-not-a-secret")
        self.assertEqual(payload["max_tokens"], 16)
        self.assertNotIn("node_id", json.dumps(payload))

    def test_stream_and_tools_refused_before_any_forward(self):
        for extra in ({"stream": True}, {"tools": []}, {"temperature": 0.5}, {"mystery": 1}):
            body = {"model": "auto", "messages": [{"role": "user", "content": "x"}], "max_tokens": 8}
            body.update(extra)
            status, out = post(self.port, "/v1/chat/completions", body)
            self.assertEqual(status, 400, extra)
            self.assertIn(out["error"]["code"],
                          ("unsupported_stream", "unsupported_tools", "unsupported_parameter", "unsupported_field"))
        self.assertEqual(FixtureFabricHandler.seen, [])

    def test_unknown_role_and_bad_tokens_refused(self):
        status, out = post(self.port, "/v1/chat/completions",
                           {"model": "auto", "messages": [{"role": "developer", "content": "x"}]})
        self.assertEqual(status, 400)
        self.assertEqual(out["error"]["code"], "invalid_role")
        status, out = post(self.port, "/v1/chat/completions",
                           {"model": "auto", "messages": [{"role": "user", "content": "x"}], "max_tokens": 5000})
        self.assertEqual(status, 400)
        self.assertEqual(FixtureFabricHandler.seen, [])

    def test_missing_user_key_is_401_and_heartbeat_store_is_never_read(self):
        os.environ.pop("FABRIC067_TEST_KEY", None)
        status, out = post(self.port, "/v1/chat/completions",
                           {"model": "auto", "messages": [{"role": "user", "content": "x"}]})
        self.assertEqual(status, 401)
        self.assertEqual(out["error"]["code"], "auth_required")
        # The proxy must not import pairing or touch its store for authority:
        # no import statement and no runtime reference outside documentation.
        import inspect
        import re
        source = inspect.getsource(proxy)
        self.assertIsNone(re.search(r'^\s*(import|from)\s+pairing\b', source, re.M))
        # Attribute access on a pairing module (the docstring's "pairing.py"
        # filename mention is documentation, not a runtime reference).
        self.assertIsNone(re.search(r'pairing\.(?!py\b)\w+', source))
        self.assertEqual(FixtureFabricHandler.seen, [])

    def test_fabric_down_is_503_with_no_direct_runtime_fallback(self):
        self.fabric.shutdown()
        self.fabric.server_close()
        status, out = post(self.port, "/v1/chat/completions",
                           {"model": "auto", "messages": [{"role": "user", "content": "x"}], "max_tokens": 8})
        self.assertEqual(status, 503)
        self.assertEqual(out["error"]["code"], "fabric_unavailable")
        # One send path only: a dead origin raises instead of falling back to
        # any direct runtime, and the fixed paths are the only forward targets.
        self.assertEqual((proxy.FABRIC_MODELS_PATH, proxy.FABRIC_CHAT_PATH), ("/v1/models", "/v1/chat/completions"))
        with self.assertRaises(OSError):
            proxy.forward_to_fabric("http://127.0.0.1:9", proxy.FABRIC_CHAT_PATH, "k", b"{}", 1.0)

    def test_host_and_query_token_guards(self):
        req = Request("http://127.0.0.1:%d/v1/models" % self.port, method="GET",
                      headers={"Host": "evil.example"})
        try:
            with urlopen(req, timeout=10):
                self.fail("foreign Host must be refused")
        except Exception as exc:
            self.assertEqual(int(exc.status), 403)
        status, out = get(self.port, "/v1/models?api_key=secret-value")
        self.assertEqual(status, 400)
        self.assertEqual(out["error"]["code"], "identity_in_url")

    def test_key_never_logged_nor_returned(self):
        sink = io.StringIO()
        with patch.object(proxy.sys, "stderr", sink):
            post(self.port, "/v1/chat/completions",
                 {"model": "auto", "messages": [{"role": "user", "content": "Say ok"}], "max_tokens": 8})
            get(self.port, "/v1/models")
            status, out = post(self.port, "/v1/chat/completions",
                               {"model": "auto", "messages": [{"role": "user", "content": "x"}],
                                "max_tokens": 8})
        logged = sink.getvalue()
        self.assertNotIn("user-key-not-a-secret", logged)
        self.assertNotIn("user-key-not-a-secret", json.dumps(out))


class OriginCase(unittest.TestCase):
    def test_resolver_gates_untrusted_origins(self):
        self.assertTrue(proxy.resolve_fabric_origin("https://fabric.example").startswith("https://"))
        self.assertTrue(proxy.resolve_fabric_origin("http://127.0.0.1:8787").startswith("http://"))
        for bad in ("http://192.168.1.9:8787", "http://fabric.example/v1?x=1",
                    "http://user:pass@127.0.0.1:8787", "ftp://127.0.0.1/x", ""):
            with self.assertRaises(proxy.ProxyConfigError, msg=bad):
                proxy.resolve_fabric_origin(bad)
        # No default origin: the operator must configure the trusted fabric
        # entrypoint explicitly, so a direct runtime is never the silent choice.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(proxy.FABRIC_ORIGIN_ENV, None)
            self.assertEqual(proxy.build_parser().parse_args([]).fabric_origin, "")
            with self.assertRaises(proxy.ProxyConfigError):
                proxy.resolve_fabric_origin(proxy.build_parser().parse_args([]).fabric_origin)
        # An explicit operator opt-in is the only non-loopback http path.
        self.assertTrue(proxy.resolve_fabric_origin("http://192.168.1.9:8787", allow_non_loopback=True)
                        .startswith("http://"))

    def test_validate_mirrors_js_bounds(self):
        ok, value = proxy.validate_chat_body({"messages": [{"role": "user", "content": "hi"}]})
        self.assertTrue(ok)
        self.assertEqual(value["model"], "auto")
        self.assertEqual(value["max_tokens"], 64)
        bad_cases = [{"messages": []}, {"model": ""}, {"max_tokens": 0}, {"max_tokens": 4097},
                     {"messages": [{"role": "user", "content": "x"}], "stream": True},
                     {"messages": [{"role": "user", "content": "x"}], "tools": []}]
        for bad in bad_cases:
            ok, _ = proxy.validate_chat_body(bad)
            self.assertFalse(ok, bad)


if __name__ == "__main__":
    unittest.main()
