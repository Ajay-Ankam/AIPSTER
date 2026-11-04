"""FABRIC067: regression tests for the loopback fabric OpenAI proxy.

Covers the six independently reproduced defects against synthetic local HTTP
only (fixture fabric origin; no model, no real credential):

  1. unauthenticated / foreign-Origin / wrong-Content-Type callers are refused
     before any forward; the caller-supplied key is forwarded verbatim and no
     ambient credential exists;
  2. upstream redirects are never followed and no credential leaves the origin;
  3. rejected query strings never reach the logs; logs are bounded lines only;
  4. upstream typed errors keep their status; transport failure (including a
     hung upstream after the POST) is uncertain with no auto-retry and no
     false undispatched claim; responses are size-bounded; proxy env is ignored;
  5. stream:false is accepted; stream:true and tools fail before dispatch;
  6. (JS side) single-message honesty is covered in website tests.

Run:  python -m unittest test_fabric_openai_proxy
"""

import io
import json
import os
import re
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import fabric_openai_proxy as proxy  # noqa: E402

CALLER_KEY = "caller-supplied-synthetic-not-a-credential"
QUERY_MARKER = "SYNTHETIC_QUERY_MARKER_067"


class FixtureFabricHandler(BaseHTTPRequestHandler):
    """Trusted-origin stand-in with scripted modes. Records Authorization."""

    seen = []
    mode = "ok"  # ok | redirect | unauthorized | hang | huge
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

    def _record(self, extra=None):
        FixtureFabricHandler.seen.append({
            "method": self.command, "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "idempotency_key": self.headers.get("Idempotency-Key"), "extra": extra,
        })

    def do_GET(self):  # noqa: N802
        self._record()
        self._reply(None)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length).decode() or "null")
        self._record(payload)
        self._reply(payload)

    def _reply(self, payload):
        mode = FixtureFabricHandler.mode
        if self.command == "GET" and mode == "status":
            # Owner-scoped status origin: only the owning key sees the op.
            if self.headers.get("Authorization") != "Bearer owner-key":
                self._send(404, {"error": {"message": "not found", "type": "invalid_request_error",
                                           "code": "not_found"}})
                return
            key = self.path[len("/v1/operations/"):] if self.path.startswith("/v1/operations/") else ""
            if key == "pending-key-00000001":
                self._send(409, {"error": {"message": "still running", "type": "invalid_request_error",
                                           "code": "operation_in_progress"},
                                 "op_id": "op-1", "automatic_retry": False})
                return
            self._send(404, {"error": {"message": "not found", "type": "invalid_request_error",
                                       "code": "not_found"}})
            return
        if mode == "hang":
            time.sleep(5)
            self._send(200, {"object": "list", "data": []})
            return
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9/capture")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if mode == "unauthorized":
            self._send(401, {"error": {"message": "bad key", "type": "auth_error", "code": "invalid_api_key"}})
            return
        if mode == "huge":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(proxy.RESPONSE_MAX_BYTES + 100))
            self.end_headers()
            self.wfile.write(b'{"object":"list","data":["' + b"x" * (proxy.RESPONSE_MAX_BYTES + 100) + b'"]}')
            return
        if self.command == "POST" and mode == "pending-post":
            self._send(409, {"error": {"message": "still running", "type": "invalid_request_error",
                                       "code": "operation_in_progress"},
                             "op_id": "op-9", "job_id": "job-9",
                             "status_route": "/v1/operations/op-9-key-00000001",
                             "automatic_retry": False})
            return
        if self.command == "GET":
            self._send(200, {"object": "list", "data": [{"id": "qwen3-fixture", "object": "model"}]})
        else:
            self._send(200, {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1700000000,
                             "model": (payload or {}).get("model"),
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"},
                                          "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}})


def start_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return server


def raw_request(port, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = Request("http://127.0.0.1:%d%s" % (port, path), data=data,
                  headers={"Content-Type": "application/json", **(headers or {})}, method=method)
    try:
        with urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except HTTPError as exc:
        return int(exc.code), exc.read().decode()


def authed(extra=None):
    headers = {"Authorization": "Bearer " + CALLER_KEY}
    if extra:
        headers.update(extra)
    return headers


class ProxyCase(unittest.TestCase):
    def setUp(self):
        FixtureFabricHandler.seen = []
        FixtureFabricHandler.mode = "ok"
        self.fabric = start_server(FixtureFabricHandler)
        self.server = start_server(proxy.FabricOpenAIProxyHandler)
        proxy.FabricOpenAIProxyHandler.fabric_origin = "http://127.0.0.1:%d" % self.fabric.server_port
        proxy.FabricOpenAIProxyHandler.timeout = 10.0
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.fabric.shutdown()
        self.fabric.server_close()

    def chat(self, obj, headers=None):
        status, text = raw_request(self.port, "POST", "/v1/chat/completions", obj, headers)
        return status, json.loads(text)

    # -- defect 1: deliberate authenticated local-caller contract ------------
    def test_unauthenticated_cross_origin_plaintext_is_refused_without_forward(self):
        n = len(FixtureFabricHandler.seen)
        status, out = self.chat(
            {"model": "auto", "messages": [{"role": "user", "content": "x"}]},
            {"Origin": "https://untrusted.example", "Content-Type": "text/plain"})
        self.assertEqual(status, 401)
        self.assertEqual(out["error"]["code"], "auth_required")
        self.assertEqual(len(FixtureFabricHandler.seen), n)

    def test_caller_key_is_forwarded_verbatim_and_no_ambient_credential_exists(self):
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "Say ok"}],
                                 "max_tokens": 16}, authed())
        self.assertEqual(status, 200)
        self.assertEqual(out["object"], "chat.completion")
        method = FixtureFabricHandler.seen[0]
        self.assertEqual(method["authorization"], "Bearer " + CALLER_KEY)
        self.assertNotIn("node_id", json.dumps(method["extra"]))
        # No ambient authority: real AST import check (docstring prose about
        # pairing is documentation, not a dependency) plus no env-key lookup.
        import ast
        import inspect
        tree = ast.parse(inspect.getsource(proxy))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertNotIn("pairing", imported)
        self.assertIsNone(re.search(r'getenv\([\'"]AIPSTER_FABRIC_API_KEY', inspect.getsource(proxy)))

    def test_foreign_origin_and_bad_content_type_refused(self):
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}]},
                                authed({"Origin": "https://untrusted.example"}))
        self.assertEqual(status, 403)
        self.assertEqual(out["error"]["code"], "foreign_origin")
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}]},
                                authed({"Content-Type": "text/plain"}))
        self.assertEqual(status, 415)
        self.assertEqual(FixtureFabricHandler.seen, [])

    def test_self_origin_is_allowed(self):
        status, _ = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}]},
                              authed({"Origin": "http://127.0.0.1:%d" % self.port}))
        self.assertEqual(status, 200)

    def test_host_must_match_loopback_and_serving_port_exactly(self):
        self.assertTrue(proxy.host_allowed("127.0.0.1:%d" % self.port, self.port))
        self.assertTrue(proxy.host_allowed("localhost:%d" % self.port, self.port))
        self.assertTrue(proxy.host_allowed("[::1]:%d" % self.port, self.port))
        for bad in ("localhost:1", "127.0.0.1:9", "evil.example:%d" % self.port,
                    "127.0.0.1", "127.0.0.1:notaport", "user@127.0.0.1:%d" % self.port,
                    "127.0.0.1:%d, evil.example" % self.port, "", None):
            self.assertFalse(proxy.host_allowed(bad, self.port), bad)
        # Surrounding whitespace is legal header OWS and strips to the exact
        # authority; anything else about it must still match exactly.
        self.assertTrue(proxy.host_allowed(" 127.0.0.1:%d " % self.port, self.port))
        status, _ = raw_request(self.port, "GET", "/v1/models", headers={"Host": "localhost:1"})
        self.assertEqual(status, 403)

    def test_identity_material_in_query_refused(self):
        status, out = raw_request(self.port, "GET", "/v1/models?api_key=" + QUERY_MARKER, headers=authed())
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(out)["error"]["code"], "identity_in_url")
        self.assertEqual(FixtureFabricHandler.seen, [])

    # -- defect 2: redirects never followed, secrets never leave -------------
    def test_redirect_is_refused_and_carries_no_credential_onward(self):
        FixtureFabricHandler.mode = "redirect"
        status, out = raw_request(self.port, "GET", "/v1/models", headers=authed())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(out)["error"]["code"], "fabric_bad_redirect")
        leaked = [e for e in FixtureFabricHandler.seen if e["authorization"] == "Bearer " + CALLER_KEY
                  and e["path"] == "/capture"]
        self.assertEqual(leaked, [])

    # -- defect 3: bounded logs only ------------------------------------------
    def test_rejected_query_never_logged_and_logs_are_bounded(self):
        sink = io.StringIO()
        with patch.object(proxy.sys, "stderr", sink):
            raw_request(self.port, "GET", "/v1/models?api_key=" + QUERY_MARKER, headers=authed())
            self.chat({"model": "auto", "messages": [{"role": "user", "content": "Say ok"}],
                       "max_tokens": 8}, authed())
            raw_request(self.port, "GET", "/v1/models", headers=authed())
        logged = sink.getvalue()
        self.assertNotIn(QUERY_MARKER, logged)
        self.assertNotIn(CALLER_KEY, logged)
        self.assertNotIn("/v1/", logged.replace("fabric-openai-proxy: status=", ""))
        for line in logged.strip().splitlines():
            self.assertRegex(line, r"^fabric-openai-proxy: status=\d+ route=(models|chat|status|other) corr=\d+$")

    def test_status_relay_preserves_scoping_and_typed_pending(self):
        FixtureFabricHandler.mode = "status"
        status, text = raw_request(self.port, "GET", "/v1/operations/pending-key-00000001",
                                   headers={"Authorization": "Bearer owner-key"})
        out = json.loads(text)
        self.assertEqual(status, 409)
        self.assertEqual(out["error"]["code"], "operation_in_progress")
        self.assertEqual(out["op_id"], "op-1")
        # A foreign key is scoped out server-side; the relay preserves the 404.
        status, text = raw_request(self.port, "GET", "/v1/operations/pending-key-00000001",
                                   headers={"Authorization": "Bearer other-key"})
        self.assertEqual(status, 404)
        # A malformed key is refused locally before any forward.
        n = len(FixtureFabricHandler.seen)
        status, out = raw_request(self.port, "GET", "/v1/operations/bad!",
                                  headers={"Authorization": "Bearer owner-key"})
        self.assertEqual(status, 400)
        self.assertEqual(len(FixtureFabricHandler.seen), n)
        # Unauthenticated status reads are refused with no forward.
        status, _ = raw_request(self.port, "GET", "/v1/operations/pending-key-00000001")
        self.assertEqual(status, 401)
        self.assertEqual(len(FixtureFabricHandler.seen), n)

    # -- finding 1: status_route preservation ---------------------------------
    def test_upstream_409_preserves_valid_status_route_end_to_end(self):
        FixtureFabricHandler.mode = "pending-post"
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "Say ok"}],
                                 "max_tokens": 8}, authed())
        self.assertEqual(status, 409)
        self.assertEqual(out["error"]["code"], "operation_in_progress")
        self.assertEqual(out["op_id"], "op-9")
        self.assertEqual(out["job_id"], "job-9")
        self.assertEqual(out["status_route"], "/v1/operations/op-9-key-00000001")
        self.assertIs(out["automatic_retry"], False)

    def test_bounded_upstream_error_preserves_valid_status_route(self):
        body = json.dumps({"error": {"code": "operation_in_progress", "message": "settling"},
                           "op_id": "op-1", "job_id": "job-9",
                           "status_route": "/v1/operations/11111111-2222-4333-8333-444444444444",
                           "automatic_retry": False}).encode()
        out = proxy._bounded_upstream_error(body)
        self.assertEqual(out["status_route"], "/v1/operations/11111111-2222-4333-8333-444444444444")
        self.assertIs(out["automatic_retry"], False)

    def test_bounded_upstream_error_refuses_hostile_status_routes(self):
        hostile = ["https://evil.example/v1/operations/abc12345",
                   "//evil.example/v1/operations/abc12345",
                   "/v1/operations/abc12345?key=x",
                   "/v1/operations/abc12345#frag",
                   "/v1/operations/../admin",
                   "/v1/operations/%2e%2e/admin",
                   "/v1/operations/",
                   "/v1/operations/abc 12345",
                   "/other/abc12345",
                   12345,
                   None]
        for bad in hostile:
            body = json.dumps({"error": {"code": "operation_in_progress", "message": "settling"},
                               "status_route": bad}).encode()
            out = proxy._bounded_upstream_error(body)
            self.assertIsNotNone(out)
            self.assertNotIn("status_route", out)

    # -- defect 4: honest upstream mapping, uncertainty, bounds ----------------
    def test_upstream_401_preserved_with_status_not_rewritten_to_503(self):
        FixtureFabricHandler.mode = "unauthorized"
        status, text = raw_request(self.port, "GET", "/v1/models", headers=authed())
        out = json.loads(text)
        self.assertEqual(status, 401)
        self.assertEqual(out["error"]["code"], "invalid_api_key")
        self.assertNotIn("not dispatched", out["error"]["message"])

    def test_hung_upstream_after_post_is_uncertain_without_retry_claim(self):
        FixtureFabricHandler.mode = "hang"
        proxy.FabricOpenAIProxyHandler.timeout = 1.0
        try:
            status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}],
                                     "max_tokens": 8}, authed())
        finally:
            proxy.FabricOpenAIProxyHandler.timeout = 10.0
        self.assertEqual(status, 503)
        self.assertEqual(out["error"]["code"], "fabric_uncertain")
        self.assertFalse(out["automatic_retry"])
        self.assertNotIn("not dispatched", out["error"]["message"])

    def test_oversized_upstream_response_refused(self):
        FixtureFabricHandler.mode = "huge"
        status, out = raw_request(self.port, "GET", "/v1/models", headers=authed())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(out)["error"]["code"], "fabric_bad_response")

    def test_proxy_environment_cannot_route_user_secrets_elsewhere(self):
        with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                                     "http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9"}):
            status, _ = raw_request(self.port, "GET", "/v1/models", headers=authed())
        self.assertEqual(status, 200)
        self.assertEqual(FixtureFabricHandler.seen[-1]["authorization"], "Bearer " + CALLER_KEY)

    def test_caller_idempotency_key_forwarded_verbatim_or_refused(self):
        status, _ = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}]},
                              authed({"Idempotency-Key": "caller-key-00000001"}))
        self.assertEqual(status, 200)
        self.assertEqual(FixtureFabricHandler.seen[-1]["idempotency_key"], "caller-key-00000001")
        n = len(FixtureFabricHandler.seen)
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}]},
                                authed({"Idempotency-Key": "bad key!"}))
        self.assertEqual(status, 400)
        self.assertEqual(len(FixtureFabricHandler.seen), n)
        status, _ = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}]},
                              authed())
        self.assertEqual(status, 200)
        self.assertIsNone(FixtureFabricHandler.seen[-1]["idempotency_key"])

    # -- defect 5: stream:false accepted ---------------------------------------
    def test_stream_false_accepted_and_stream_true_refused_before_forward(self):
        status, _ = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}],
                               "stream": False}, authed())
        self.assertEqual(status, 200)
        n = len(FixtureFabricHandler.seen)
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}],
                                 "stream": True}, authed())
        self.assertEqual(status, 400)
        self.assertEqual(out["error"]["code"], "unsupported_stream")
        status, out = self.chat({"model": "auto", "messages": [{"role": "user", "content": "x"}],
                                 "tools": []}, authed())
        self.assertEqual(status, 400)
        self.assertEqual(out["error"]["code"], "unsupported_tools")
        self.assertEqual(len(FixtureFabricHandler.seen), n)


class OriginCase(unittest.TestCase):
    def test_resolver_gates_untrusted_origins(self):
        self.assertTrue(proxy.resolve_fabric_origin("https://fabric.example").startswith("https://"))
        self.assertTrue(proxy.resolve_fabric_origin("http://127.0.0.1:8787").startswith("http://"))
        for bad in ("http://192.168.1.9:8787", "http://fabric.example/v1?x=1",
                    "http://user:pass@127.0.0.1:8787", "ftp://127.0.0.1/x", ""):
            with self.assertRaises(proxy.ProxyConfigError, msg=bad):
                proxy.resolve_fabric_origin(bad)
        self.assertTrue(proxy.resolve_fabric_origin("http://192.168.1.9:8787", allow_non_loopback=True)
                        .startswith("http://"))
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(proxy.FABRIC_ORIGIN_ENV, None)
            self.assertEqual(proxy.build_parser().parse_args([]).fabric_origin, "")
            with self.assertRaises(proxy.ProxyConfigError):
                proxy.resolve_fabric_origin(proxy.build_parser().parse_args([]).fabric_origin)

    def test_validate_mirrors_js_bounds(self):
        ok, value = proxy.validate_chat_body({"messages": [{"role": "user", "content": "hi"}]})
        self.assertTrue(ok)
        self.assertEqual(value["model"], "auto")
        self.assertEqual(value["max_tokens"], 64)
        ok, _ = proxy.validate_chat_body({"messages": [{"role": "user", "content": "hi"}], "stream": False})
        self.assertTrue(ok)
        for bad in [{"messages": []}, {"model": ""}, {"max_tokens": 0}, {"max_tokens": 4097},
                    {"messages": [{"role": "user", "content": "x"}], "stream": True},
                    {"messages": [{"role": "user", "content": "x"}], "tools": []}]:
            ok, _ = proxy.validate_chat_body(bad)
            self.assertFalse(ok, bad)


if __name__ == "__main__":
    unittest.main()
