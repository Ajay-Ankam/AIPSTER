"""FABRIC067: loopback-only OpenAI-compatible proxy to the fabric entrypoint.

A coding client points its OpenAI base URL at this proxy
(http://127.0.0.1:<port>) and authenticates EVERY request with its own
``Authorization: Bearer <per-user-fabric-key>`` header. The proxy validates
the request with bounded fields and forwards it to ONE explicitly configured,
trusted fabric origin. The central fabric selects the eligible machine/model
from authorized fresh inventory, dispatches through the existing
admission/placement/reservation/lease/worker-result settlement, and returns
the compatible response.

Deliberate local-caller contract (all enforced, all tested):

  * Loopback ``Host`` with the EXACT serving port (robust authority parse;
    userinfo, foreign hosts and wrong ports are refused with 403).
  * Caller-supplied ``Authorization: Bearer`` on every request, forwarded
    verbatim to the fixed origin. There is NO ambient credential: no
    environment key, no pairing/heartbeat credential (this module does not
    import pairing and never reads its store). Unauthenticated callers get
    401 and nothing is forwarded.
  * Non-browser local clients send no ``Origin``. A present ``Origin`` must
    equal this proxy's own loopback origin, otherwise the request is refused
    as browser-origin abuse (403). Credentials never travel in URLs: query
    keys that look like identity material are refused (400).
  * ``POST`` requires ``Content-Type: application/json`` (415 otherwise).
  * The fabric origin is fixed at startup: https, or loopback http unless
    --allow-non-loopback-fabric is given. Only the fixed fabric paths
    /v1/models, /v1/chat/completions and /v1/operations/<key> (strict key
    shape) are forwarded (no SSRF).
  * Redirects are never followed: any 3xx from the fabric becomes a 502 and
    no credential leaves the configured origin. A no-proxy opener is used so
    proxy environment variables cannot route user secrets elsewhere.
  * Upstream typed errors are preserved with their HTTP status (bounded).
    Transport failure (timeout/connection loss, including after the POST was
    sent) is UNCERTAIN: 503 fabric_uncertain, never auto-retried, and never
    claimed as undispatched without evidence. Responses are size-bounded.
  * ``stream: false`` is accepted (ordinary explicit non-streaming clients);
    ``stream: true`` and tool parameters are refused with explicit typed
    errors before any forward; nothing is auto-executed.
  * Logs are bounded status/correlation lines only: no raw request line,
    URLs, headers, bodies, or exception text. No key material is ever logged
    or returned.

Standard library only, like pairing.py.
"""

import argparse
import itertools
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlparse, parse_qsl
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

FABRIC_INTERFACE = "aipster-fabric-openai-proxy/1"
FABRIC_MODELS_PATH = "/v1/models"
FABRIC_CHAT_PATH = "/v1/chat/completions"
FABRIC_STATUS_PREFIX = "/v1/operations/"
FABRIC_ORIGIN_ENV = "AIPSTER_FABRIC_ORIGIN"

MODEL_MAX = 256
MESSAGES_MAX = 128
MESSAGE_CONTENT_MAX = 65536
MAX_TOKENS_CEILING = 4096
DEFAULT_MAX_TOKENS = 64
BODY_MAX_BYTES = 256 * 1024
RESPONSE_MAX_BYTES = 1024 * 1024
TOKEN_MAX_CHARS = 1024
# Caller idempotency keys travel end to end (proxy -> fabric route) so SDK
# retries reconcile instead of redispatching. Same shape the route enforces.
IDEMPOTENCY_KEY_RE_TEXT = r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}"
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
    port = ":%d" % parsed.port if parsed.port else ""
    return "%s://%s%s" % (parsed.scheme, parsed.hostname, port)


def openai_error(http_status, code, message, extra=None):
    """Typed OpenAI-style error body (never carries key material)."""
    body = {"error": {"message": str(message)[:500],
                      "type": "server_error" if http_status >= 500 else "invalid_request_error",
                      "code": str(code)}}
    if extra:
        body.update(extra)
    return body


def validate_chat_body(body):
    """Bounded validation mirroring website/src/inference/fabric-openai.mjs.

    ``stream: false`` is an ordinary explicit non-streaming request and is
    accepted; ``stream: true`` (and any stream/tool parameter) is refused
    honestly before any forward. Returns (True, value) or (False, error).
    """
    if not isinstance(body, dict):
        return False, {"http": 400, "code": "invalid_request", "message": "A JSON object is required."}
    for key in body:
        if key in TOOL_FIELDS:
            return False, {"http": 400, "code": "unsupported_tools",
                           "message": "Tool calling is a separate qualification and is not enabled; the request was not dispatched."}
        if key in STREAM_FIELDS:
            if key == "stream" and body[key] is False:
                continue
            return False, {"http": 400, "code": "unsupported_stream",
                           "message": "Streaming is not supported by the fabric transport; the request was not dispatched."}
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


class _RefuseRedirect(HTTPRedirectHandler):
    """Never follow redirects: the 3xx response passes through unfolded."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _opener():
    # Empty proxy map: proxy environment variables must never route user
    # secrets away from the configured origin.
    return build_opener(ProxyHandler({}), _RefuseRedirect())


def forward_to_fabric(origin, path, bearer, payload_bytes, timeout, idempotency_key=None):
    """Exchange with ONE fixed fabric path. Returns (status, body_bytes).

    Any HTTP response (including 3xx/4xx/5xx) is returned unfolded for the
    caller to map; redirects are never followed. Non-2xx statuses relay
    unchanged so SDKs raise typed errors instead of parsing receipts as
    completions. Raises OSError only on transport failure (timeout, refused,
    reset), which the caller treats as an UNCERTAIN outcome, never as proof
    of non-dispatch.
    """
    url = origin + path
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + bearer,
               "User-Agent": "aipster-fabric-openai-proxy/1"}
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    req = Request(url, data=payload_bytes, headers=headers, method="POST" if payload_bytes is not None else "GET")
    try:
        with _opener().open(req, timeout=timeout) as resp:
            return int(resp.status), resp.read(RESPONSE_MAX_BYTES + 1)
    except HTTPError as exc:
        try:
            return int(exc.code), exc.read(RESPONSE_MAX_BYTES + 1)
        except Exception as exc2:
            raise OSError("fabric response unreadable: %s" % type(exc2).__name__) from exc2
    except Exception as exc:
        raise OSError("fabric unavailable: %s" % type(exc).__name__) from exc


def parse_host_authority(host_header):
    """Robustly split a Host header into (hostname, port) or None.

    Refuses whitespace, userinfo, multi-host lists and malformed ports so a
    smuggled authority can never pass the loopback check.
    """
    if not isinstance(host_header, str):
        return None
    value = host_header.strip()
    if not value or any(ch.isspace() for ch in value) or "," in value or "@" in value:
        return None
    if value.startswith("["):
        end = value.find("]")
        if end < 0:
            return None
        host = value[1:end].lower()
        rest = value[end + 1:]
        if rest and not rest.startswith(":"):
            return None
        port_text = rest[1:] if rest else ""
    elif value.count(":") > 1:
        return None
    else:
        host, _, port_text = value.partition(":")
        host = host.lower()
    if not host:
        return None
    host = host[:-1] if host.endswith(".") and len(host) > 1 else host
    if not port_text:
        return host, None
    if not port_text.isdigit():
        return None
    port = int(port_text)
    if not 1 <= port <= 65535:
        return None
    return host, port


def host_allowed(host_header, serving_port):
    """Exact loopback Host INCLUDING the serving port."""
    parsed = parse_host_authority(host_header)
    if parsed is None:
        return False
    host, port = parsed
    return host in LOOPBACK_HOSTS and port == serving_port


def parse_bearer(authorization):
    """Validate a caller-supplied Authorization header. Returns the token or None."""
    if not isinstance(authorization, str):
        return None
    scheme, _, token = authorization.strip().partition(" ")
    if scheme != "Bearer" or not token or any(ch.isspace() for ch in token):
        return None
    if len(token) > TOKEN_MAX_CHARS:
        return None
    return token


class FabricOpenAIProxyHandler(BaseHTTPRequestHandler):
    """HTTP handler. Class attributes are set by serve(): fabric_origin,
    timeout. Logs are bounded status/correlation lines only."""

    fabric_origin = None
    timeout = 60.0
    server_version = "AIPSTERFabricOpenAIProxy/1"
    corr = itertools.count(1)

    # -- logging: bounded status/correlation only ---------------------------
    def log_request(self, code="-", size="-"):
        pass  # never emit the raw request line (it carries path/query)

    def log_message(self, fmt, *args):  # noqa: D102 - fixed-shape emission only
        sys.stderr.write("fabric-openai-proxy: " + (fmt % args) + "\n")

    def _log(self, status, route):
        self.log_message("status=%s route=%s corr=%s", status, route, next(type(self).corr))

    # -- helpers -------------------------------------------------------------
    def _send_json(self, http_status, obj, route):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(http_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        self._log(http_status, route)

    def _guard(self, route):
        """Enforce the local-caller contract. Returns the bearer or None.

        Order: connection scope (Host), caller identity (Authorization), then
        request-shape abuse (foreign Origin, identity in URL). An unauthenticated
        caller always gets 401 and nothing is forwarded, whatever else is wrong.
        """
        if not host_allowed(self.headers.get("Host"), self.server.server_port):
            self._send_json(403, openai_error(403, "forbidden_host", "This proxy serves loopback clients on its own port only."), route)
            return None
        bearer = parse_bearer(self.headers.get("Authorization"))
        if bearer is None:
            self._send_json(401, openai_error(401, "auth_required",
                                             "A caller-supplied per-user fabric key is required in the Authorization header; there is no ambient credential."), route)
            return None
        origin = self.headers.get("Origin")
        if origin is not None and origin not in (
                "http://127.0.0.1:%d" % self.server.server_port,
                "http://localhost:%d" % self.server.server_port,
                "http://[::1]:%d" % self.server.server_port):
            self._send_json(403, openai_error(403, "foreign_origin",
                                             "Browser-origin requests are refused; use a direct loopback client."), route)
            return None
        query = urlparse(self.path).query
        if query:
            keys = {k.lower() for k, _ in parse_qsl(query, keep_blank_values=True)}
            if keys & set(TOKEN_QUERY_KEYS):
                self._send_json(400, openai_error(400, "identity_in_url",
                                                 "Credentials must travel in the Authorization header, never in the URL."), route)
                return None
        return bearer

    def _relay(self, bearer, path, payload_bytes, route, idempotency_key=None):
        try:
            status, data = forward_to_fabric(self.fabric_origin, path, bearer, payload_bytes,
                                             self.timeout, idempotency_key=idempotency_key)
        except OSError:
            # Transport failure, possibly AFTER the POST was sent: the outcome
            # is uncertain. Never auto-retried, never claimed undispatched.
            self._send_json(503, openai_error(503, "fabric_uncertain",
                                             "The fabric request outcome is uncertain after a transport failure; it was not retried automatically.",
                                             {"automatic_retry": False}), route)
            return
        if len(data) > RESPONSE_MAX_BYTES:
            self._send_json(502, openai_error(502, "fabric_bad_response", "The fabric response exceeded the size bound."), route)
            return
        if 200 <= status < 300:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self._log(status, route)
            return
        if status in (301, 302, 303, 307, 308):
            # Redirects are never followed; no credential leaves the origin.
            self._send_json(502, openai_error(502, "fabric_bad_redirect", "The fabric entrypoint redirected; redirects are never followed."), route)
            return
        bounded = _bounded_upstream_error(data)
        if bounded is not None:
            self._send_json(status, bounded, route)
            return
        self._send_json(502, openai_error(502, "fabric_bad_response", "The fabric entrypoint returned an unreadable error."), route)

    def _status_key(self):
        """Strict /v1/operations/<key> split: (route, key) or (route, None).

        Anything under the prefix with a malformed key is 400; anything else
        unknown is 404. The key travels in the path only; query identity
        material is refused by the shared guard.
        """
        path = urlparse(self.path).path
        if path == FABRIC_MODELS_PATH:
            return "models", None
        if path == FABRIC_STATUS_PREFIX:
            return "status", None
        if path.startswith(FABRIC_STATUS_PREFIX):
            key = path[len(FABRIC_STATUS_PREFIX):]
            if re.fullmatch(IDEMPOTENCY_KEY_RE_TEXT, key):
                return "status", key
            return "status", None
        return "other", None

    def do_GET(self):  # noqa: N802 - stdlib handler name
        route, status_key = self._status_key()
        bearer = self._guard(route)
        if bearer is None:
            return
        if route == "models":
            self._relay(bearer, FABRIC_MODELS_PATH, None, route)
            return
        if route == "status" and status_key is not None:
            # Bounded authenticated status relay: the caller reconciles its
            # own pending outcomes through its advertised base URL. Owner
            # scoping is enforced server-side; the relay preserves whatever
            # typed pending/error status the fabric returns, unchanged.
            self._relay(bearer, FABRIC_STATUS_PREFIX + status_key, None, route)
            return
        if route == "status":
            self._send_json(400, openai_error(400, "invalid_request",
                                             "A valid operation key is required in the path."), route)
            return
        self._send_json(404, openai_error(404, "not_found", "Unknown proxy route."), route)
        return

    def do_POST(self):  # noqa: N802 - stdlib handler name
        route = "chat" if urlparse(self.path).path == FABRIC_CHAT_PATH else "other"
        bearer = self._guard(route)
        if bearer is None:
            return
        if route != "chat":
            self._send_json(404, openai_error(404, "not_found", "Unknown proxy route."), route)
            return
        if self.headers.get_content_type() != "application/json":
            self._send_json(415, openai_error(415, "unsupported_media_type", "POST requires Content-Type: application/json."), route)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > BODY_MAX_BYTES:
            self._send_json(400, openai_error(400, "invalid_request", "A JSON body within 256 KiB is required."), route)
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, openai_error(400, "invalid_request", "Malformed JSON body."), route)
            return
        ok, value = validate_chat_body(body)
        if not ok:
            self._send_json(value["http"], openai_error(value["http"], value["code"], value["message"]), route)
            return
        # Caller idempotency keys travel end to end so SDK retries reconcile
        # instead of redispatching. A supplied malformed key is refused here,
        # matching the route contract; an absent key is simply not forwarded.
        idem = self.headers.get("Idempotency-Key")
        if idem is not None and not re.fullmatch(IDEMPOTENCY_KEY_RE_TEXT, idem):
            self._send_json(400, openai_error(400, "invalid_request",
                                             "Idempotency-Key must match [A-Za-z0-9][A-Za-z0-9._:-]{7,127}."), route)
            return
        payload = json.dumps({"model": value["model"], "messages": value["messages"],
                              "max_tokens": value["max_tokens"]}).encode("utf-8")
        self._relay(bearer, FABRIC_CHAT_PATH, payload, route, idempotency_key=idem)


def _bounded_upstream_error(data):
    """Preserve a bounded typed upstream error, else None.

    Correlation fields travel with the error so callers can reconcile: op_id
    and job_id when they are short identifiers, automatic_retry when it is a
    real boolean. Everything else is dropped.
    """
    try:
        obj = json.loads(bytes(data).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("error"), dict):
        return None
    err = obj["error"]
    code = err.get("code")
    message = err.get("message")
    if not isinstance(code, str) or not code or not isinstance(message, str) or not message:
        return None
    out = {"error": {"message": message[:500], "code": code[:128],
                     "type": err.get("type") if isinstance(err.get("type"), str) else "server_error"}}
    for key in ("op_id", "job_id"):
        value = obj.get(key)
        if isinstance(value, str) and value and len(value) <= 128 \
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", value):
            out[key] = value
    if isinstance(obj.get("automatic_retry"), bool):
        out["automatic_retry"] = obj["automatic_retry"]
    return out


def build_parser():
    """CLI for the loopback proxy (operator-started, like serve-jobs)."""
    parser = argparse.ArgumentParser(description="Loopback OpenAI proxy to the trusted fabric entrypoint.")
    parser.add_argument("--fabric-origin", default=os.environ.get(FABRIC_ORIGIN_ENV, ""),
                        help="Trusted fabric origin (https, or loopback http). No per-request overrides.")
    parser.add_argument("--port", type=int, default=8089, help="Loopback port to serve (127.0.0.1 only).")
    parser.add_argument("--timeout", type=float, default=60.0, help="Per-request fabric timeout in seconds (<=60).")
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
