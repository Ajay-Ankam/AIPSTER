"""FABRIC067: loopback-only OpenAI-compatible proxy to the fabric entrypoint.

A coding client points its OpenAI base URL at this proxy
(http://127.0.0.1:<port>). The proxy validates the request with bounded
fields and forwards it to ONE explicitly configured, trusted fabric origin
(e.g. the site's future POST /v1/chat/completions route, applied by the
worker.js owner at idle). The central fabric selects the eligible
machine/model from authorized fresh inventory, dispatches through the
existing admission/placement/reservation/lease/worker-result settlement,
and returns the compatible response.

Hard boundaries (see module docstring asserts in tests):

  * This proxy NEVER contacts a direct local runtime. There is no code path
    to the loopback daemon API on 8090, the resident llama server on 8124,
    or Ganglion on 8471, and no fallback when the fabric is unavailable:
    fabric errors surface as truthful typed OpenAI errors (503).
  * The heartbeat/pairing credential NEVER authorizes user model requests.
    This module does not import pairing and never reads the pairing private
    store. The user credential comes only from the environment
    (AIPSTER_FABRIC_API_KEY): an existing per-user inference key, never
    minted, rotated, or stored here, never logged, never returned, and never
    placed in a URL (Authorization header only).
  * The fabric origin is fixed at startup: https, or loopback http unless
    --allow-non-loopback-fabric is given. Arbitrary caller-controlled
    upstream URLs are rejected (no SSRF): only the two fixed fabric paths
    /v1/models and /v1/chat/completions are forwarded.
  * Streaming and tool calling are refused with explicit typed errors before
    any forward; nothing is auto-executed and no fake token stream is built.
  * Binds 127.0.0.1 only. Host allowlist (loopback + serving port) and
    query-string token rejection stay on.

Standard library only, like pairing.py.
"""

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qsl
from urllib.request import Request, build_opener

FABRIC_INTERFACE = "aipster-fabric-openai-proxy/1"
FABRIC_MODELS_PATH = "/v1/models"
FABRIC_CHAT_PATH = "/v1/chat/completions"
API_KEY_ENV = "AIPSTER_FABRIC_API_KEY"
FABRIC_ORIGIN_ENV = "AIPSTER_FABRIC_ORIGIN"

MODEL_MAX = 256
MESSAGES_MAX = 128
MESSAGE_CONTENT_MAX = 65536
MAX_TOKENS_CEILING = 4096
DEFAULT_MAX_TOKENS = 64
BODY_MAX_BYTES = 256 * 1024
ROLES = ("system", "user", "assistant", "tool")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

STREAM_FIELDS = ("stream", "stream_options")
TOOL_FIELDS = ("tools", "tool_choice", "functions", "function_call", "parallel_tool_calls")
SAMPLING_FIELDS = ("temperature", "top_p", "top_k", "seed", "stop", "n",
                   "presence_penalty", "frequency_penalty", "logit_bias",
                   "logprobs", "top_logprobs", "response_format", "user")
ALLOWED_FIELDS = ("model", "messages", "max_tokens")
ALLOWED_MESSAGE_FIELDS = ("role", "content", "name")
# Query keys that would carry identity material in a URL: always refused.
TOKEN_QUERY_KEYS = ("key", "api_key", "apikey", "token", "access_token", "auth")


class ProxyConfigError(ValueError):
    """Startup configuration refusal (untrusted origin, bad port)."""


def resolve_fabric_origin(raw, allow_non_loopback=False):
    """Normalize and gate the single trusted fabric origin.

    Returns "scheme://host[:port]" with no path, query, fragment, or
    userinfo. Only https, or http on a loopback host (unless explicitly
    allowed otherwise), is accepted. Anything else raises ProxyConfigError,
    so a caller can never steer the proxy at an arbitrary upstream.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ProxyConfigError("a fabric origin is required")
    parsed = urlparse(raw.strip())
    if parsed.scheme not in ("http", "https"):
        raise ProxyConfigError("fabric origin must be http(s)")
    if parsed.username or parsed.password:
        raise ProxyConfigError("fabric origin must not embed credentials")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ProxyConfigError("fabric origin needs a host")
    if parsed.scheme == "http" and host not in LOOPBACK_HOSTS and not allow_non_loopback:
        raise ProxyConfigError("plain-http fabric origin must be loopback")
    if parsed.query or parsed.fragment:
        raise ProxyConfigError("fabric origin must not carry query or fragment")
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def openai_error(http_status, code, message):
    """Typed OpenAI-style error body (never carries key material)."""
    return {"error": {"message": str(message), "type": "server_error" if http_status >= 500 else "invalid_request_error",
                      "code": str(code)}}


def validate_chat_body(body):
    """Bounded validation mirroring website/src/inference/fabric-openai.mjs.

    Returns (True, {"model", "messages", "max_tokens"}) or
    (False, {"http", "code", "message"}). Stream/tools are refused honestly
    before any forward; roles are never relabelled.
    """
    if not isinstance(body, dict):
        return False, {"http": 400, "code": "invalid_request", "message": "A JSON object is required."}
    for key in body:
        if key in STREAM_FIELDS:
            return False, {"http": 400, "code": "unsupported_stream",
                           "message": "Streaming is not supported by the fabric transport; the request was not dispatched."}
        if key in TOOL_FIELDS:
            return False, {"http": 400, "code": "unsupported_tools",
                           "message": "Tool calling is a separate qualification and is not enabled; the request was not dispatched."}
        if key in SAMPLING_FIELDS:
            return False, {"http": 400, "code": "unsupported_parameter",
                           "message": "Parameter %r is not supported; the request was not dispatched." % (key,)}
        if key not in ALLOWED_FIELDS:
            return False, {"http": 400, "code": "unsupported_field",
                           "message": "Field %r is not accepted. Only model, messages and max_tokens are accepted." % (key,)}
    model = body.get("model", "auto")
    if not isinstance(model, str) or not model or len(model) > MODEL_MAX:
        return False, {"http": 400, "code": "invalid_model",
                       "message": "model must be a non-empty string of at most 256 characters."}
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages or len(messages) > MESSAGES_MAX:
        return False, {"http": 400, "code": "invalid_messages",
                       "message": "messages must be an array of 1..%d entries." % MESSAGES_MAX}
    clean = []
    for i, entry in enumerate(messages):
        if not isinstance(entry, dict) or any(k not in ALLOWED_MESSAGE_FIELDS for k in entry):
            return False, {"http": 400, "code": "invalid_message",
                           "message": "messages[%d] must contain only role, content and name." % i}
        if entry.get("role") not in ROLES:
            return False, {"http": 400, "code": "invalid_role",
                           "message": "messages[%d].role %r is not one of: %s. Roles are never re-labelled silently."
                                      % (i, entry.get("role"), ", ".join(ROLES))}
        content = entry.get("content")
        if not isinstance(content, str) or not content.strip() or len(content) > MESSAGE_CONTENT_MAX:
            return False, {"http": 400, "code": "invalid_message",
                           "message": "messages[%d].content must be non-empty text of at most %d characters."
                                      % (i, MESSAGE_CONTENT_MAX)}
        item = {"role": entry["role"], "content": content}
        if entry.get("name") is not None:
            item["name"] = entry["name"]
        clean.append(item)
    max_tokens = body.get("max_tokens", DEFAULT_MAX_TOKENS)
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) \
            or max_tokens < 1 or max_tokens > MAX_TOKENS_CEILING:
        return False, {"http": 400, "code": "invalid_max_tokens",
                       "message": "max_tokens must be an integer in 1..%d." % MAX_TOKENS_CEILING}
    return True, {"model": model, "messages": clean, "max_tokens": max_tokens}


def forward_to_fabric(origin, path, api_key, payload_bytes, timeout):
    """POST/GET one fixed fabric path. Returns (status, body_bytes).

    Raises OSError on transport failure (caller maps to 503). The key travels
    in the Authorization header only; the URL is origin + fixed path.
    """
    url = origin + path
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + api_key,
               "User-Agent": "aipster-fabric-openai-proxy/1"}
    req = Request(url, data=payload_bytes, headers=headers, method="POST" if payload_bytes is not None else "GET")
    opener = build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            return int(resp.status), resp.read()
    except Exception as exc:
        raise OSError("fabric unavailable: %s" % type(exc).__name__) from exc


def _host_allowed(host_header, port):
    if not host_header:
        return False
    host = host_header.split(":")[0].strip().lower().strip("[]")
    if host in LOOPBACK_HOSTS:
        return True
    return False


class FabricOpenAIProxyHandler(BaseHTTPRequestHandler):
    """HTTP handler. Class attributes are set by serve(): fabric_origin,
    api_key_env, timeout. Logs carry ids/status only, never credentials,
    prompts, or completions."""

    fabric_origin = None
    api_key_env = API_KEY_ENV
    timeout = 60.0
    server_version = "AIPSTERFabricOpenAIProxy/1"

    def log_message(self, fmt, *args):  # noqa: D102 - keep stdlib quiet-ish
        sys.stderr.write("fabric-openai-proxy: " + (fmt % args) + "\n")

    def _send_json(self, http_status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(http_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _forbidden_host(self):
        port = self.server.server_port if self.server else 0
        if not _host_allowed(self.headers.get("Host"), port):
            self._send_json(403, openai_error(403, "forbidden_host", "This proxy serves loopback clients only."))
            return True
        return False

    def _token_in_query(self):
        query = urlparse(self.path).query
        if not query:
            return False
        keys = {k.lower() for k, _ in parse_qsl(query, keep_blank_values=True)}
        if keys & set(TOKEN_QUERY_KEYS):
            self._send_json(400, openai_error(400, "identity_in_url",
                                             "Credentials must travel in the Authorization header, never in the URL."))
            return True
        return False

    def _user_key(self):
        key = os.environ.get(self.api_key_env, "")
        if not isinstance(key, str) or not key:
            self._send_json(401, openai_error(401, "auth_required",
                                             "A per-user fabric API key is required (%s); the heartbeat key never authorizes model requests."
                                             % self.api_key_env))
            return None
        return key

    def do_GET(self):  # noqa: N802 - stdlib handler name
        if self._forbidden_host() or self._token_in_query():
            return
        if urlparse(self.path).path != FABRIC_MODELS_PATH:
            self._send_json(404, openai_error(404, "not_found", "Unknown proxy route; only /v1/models and /v1/chat/completions exist."))
            return
        key = self._user_key()
        if key is None:
            return
        try:
            status, data = forward_to_fabric(self.fabric_origin, FABRIC_MODELS_PATH, key, None, self.timeout)
        except OSError:
            self._send_json(503, openai_error(503, "fabric_unavailable",
                                             "The fabric entrypoint is unavailable; the request was not dispatched and no direct runtime was used."))
            return
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802 - stdlib handler name
        if self._forbidden_host() or self._token_in_query():
            return
        if urlparse(self.path).path != FABRIC_CHAT_PATH:
            self._send_json(404, openai_error(404, "not_found", "Unknown proxy route; only /v1/models and /v1/chat/completions exist."))
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > BODY_MAX_BYTES:
            self._send_json(400 if length else 400, openai_error(400, "invalid_request", "A JSON body within 256 KiB is required."))
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, openai_error(400, "invalid_request", "Malformed JSON body."))
            return
        ok, value = validate_chat_body(body)
        if not ok:
            self._send_json(value["http"], openai_error(value["http"], value["code"], value["message"]))
            return
        key = self._user_key()
        if key is None:
            return
        payload = json.dumps({"model": value["model"], "messages": value["messages"],
                              "max_tokens": value["max_tokens"]}).encode("utf-8")
        try:
            status, data = forward_to_fabric(self.fabric_origin, FABRIC_CHAT_PATH, key, payload, self.timeout)
        except OSError:
            self._send_json(503, openai_error(503, "fabric_unavailable",
                                             "The fabric entrypoint is unavailable; the request was not dispatched and no direct runtime was used."))
            return
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def build_parser():
    """CLI for the loopback proxy (operator-started, like serve-jobs)."""
    parser = argparse.ArgumentParser(description="Loopback OpenAI proxy to the trusted fabric entrypoint.")
    parser.add_argument("--fabric-origin", default=os.environ.get(FABRIC_ORIGIN_ENV, ""),
                        help="Trusted fabric origin (https, or loopback http). No per-request overrides.")
    parser.add_argument("--port", type=int, default=8089, help="Loopback port to serve (127.0.0.1 only).")
    parser.add_argument("--timeout", type=float, default=60.0, help="Per-request fabric timeout in seconds (<=60).")
    parser.add_argument("--api-key-env", default=API_KEY_ENV,
                        help="Environment variable holding the existing per-user fabric API key.")
    parser.add_argument("--allow-non-loopback-fabric", action="store_true",
                        help="Permit a non-loopback plain-http fabric origin (operator opt-in only).")
    return parser


def serve(foreground_args=None):
    """Start the loopback proxy. Returns the exit code (0 until stopped)."""
    args = build_parser().parse_args(foreground_args)
    try:
        origin = resolve_fabric_origin(args.fabric_origin,
                                       allow_non_loopback=args.allow_non_loopback_fabric)
    except ProxyConfigError as exc:
        print("fabric-openai-proxy: refused fabric origin: %s" % exc, file=sys.stderr)
        return 2
    if not 1 <= args.port <= 65535:
        print("fabric-openai-proxy: bad port", file=sys.stderr)
        return 2
    FabricOpenAIProxyHandler.fabric_origin = origin
    FabricOpenAIProxyHandler.api_key_env = args.api_key_env
    FabricOpenAIProxyHandler.timeout = min(max(args.timeout, 1.0), 60.0)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), FabricOpenAIProxyHandler)
    print("fabric-openai-proxy: serving http://127.0.0.1:%d -> %s" % (args.port, origin))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
