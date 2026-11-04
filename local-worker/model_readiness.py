"""FABRIC067: worker-origin model readiness evidence (report helper only).

The fabric must route only to models a worker actually serves. The existing
capability schema (v1) reports runtime names, formats and memory, but no
model IDs, so the server cannot qualify placement from it. This module builds
the missing typed evidence: per-runtime model IDs read from that runtime's
own loopback ``/v1/models`` surface at report time.

Shape (attached inside capability ``runtimes[]`` entries as ``models``; the
current server intake ignores unknown runtime keys, so this is transport-
compatible with the deployed validator — see the integration contract for the
exact pairing.py call site owned by WEB066):

  {"runtime_id": "llama-server", "observed_at_ms": <int>,
   "models": [{"model_id": "...", "ready": true}, ...]}

Rules:

  * ``ready: true`` means listed by the upstream at ``observed_at_ms``.
    Unlisted models are absent, never ``ready: false`` guesses.
  * Runtime ids are exactly ``ganglion`` | ``llama-server`` (the qualified
    CPU transport set). Anything else is refused, never mapped or fallen back.
  * The upstream base must be loopback unless explicitly allowed; model ids
    are bounded (1..256 chars, at most 64 per runtime, deduplicated).
  * No keys, prompts, completions, or daemon credentials are touched: this
    reads the local upstream's public model list only.

Standard library only, like pairing.py.
"""

import json
import time
from urllib.parse import urlparse
from urllib.request import Request, build_opener, ProxyHandler

READINESS_SCHEMA = "aipster-model-readiness/1"
READINESS_RUNTIMES = ("ganglion", "llama-server")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
MODEL_ID_MAX = 256
MODELS_MAX = 64
MODELS_TIMEOUT_SEC = 5


class ReadinessError(ValueError):
    """Refusal to build or fetch model evidence."""


def check_runtime_id(raw):
    """Strict runtime identity for the qualified transport set."""
    if raw not in READINESS_RUNTIMES:
        raise ReadinessError("runtime %r is not one of: %s" % (raw, ", ".join(READINESS_RUNTIMES)))
    return raw


def clean_model_ids(raw):
    """Bounded, deduplicated model ids preserving upstream order."""
    if not isinstance(raw, list):
        raise ReadinessError("models must be a list")
    clean = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, str) or not entry or len(entry) > MODEL_ID_MAX:
            raise ReadinessError("model ids must be 1..256 char strings")
        if entry in seen:
            continue
        seen.add(entry)
        clean.append(entry)
        if len(clean) > MODELS_MAX:
            raise ReadinessError("at most %d models per runtime" % MODELS_MAX)
    return clean


def build_model_evidence(models, runtime_id, now_ms=None):
    """Build one runtime's typed evidence from upstream-listed model ids."""
    check_runtime_id(runtime_id)
    ids = clean_model_ids(models)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    if now < 0:
        raise ReadinessError("now_ms must be non-negative")
    return {"schema": READINESS_SCHEMA, "runtime_id": runtime_id, "observed_at_ms": now,
            "models": [{"model_id": mid, "ready": True} for mid in ids]}


def check_upstream_base(raw, allow_non_loopback=False):
    """Gate a local upstream base URL (loopback by default, no credentials)."""
    if not isinstance(raw, str) or not raw.strip():
        raise ReadinessError("an upstream base URL is required")
    parsed = urlparse(raw.strip())
    if parsed.scheme not in ("http", "https"):
        raise ReadinessError("upstream base must be http(s)")
    if parsed.username or parsed.password:
        raise ReadinessError("upstream base must not embed credentials")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ReadinessError("upstream base needs a host")
    if host not in LOOPBACK_HOSTS and not allow_non_loopback:
        raise ReadinessError("non-loopback upstream requires explicit opt-in")
    if parsed.query or parsed.fragment:
        raise ReadinessError("upstream base must not carry query or fragment")
    port = ":%d" % parsed.port if parsed.port else ""
    return "%s://%s%s" % (parsed.scheme, parsed.hostname, port)


def collect_upstream_models(base, token=None, timeout=MODELS_TIMEOUT_SEC, allow_non_loopback=False):
    """Read model ids from the runtime's own loopback /v1/models surface.

    Raises ReadinessError on any transport or shape failure: absence of
    evidence is never reported as readiness.
    """
    origin = check_upstream_base(base, allow_non_loopback=allow_non_loopback)
    headers = {"User-Agent": "aipster-model-readiness/1"}
    if token is not None:
        if not isinstance(token, str) or not token:
            raise ReadinessError("token must be a non-empty string")
        headers["Authorization"] = "Bearer " + token
    req = Request(origin + "/v1/models", headers=headers, method="GET")
    try:
        with build_opener(ProxyHandler({})).open(req, timeout=timeout) as resp:
            if int(resp.status) != 200:
                raise ReadinessError("upstream /v1/models returned HTTP %s" % resp.status)
            body = json.loads(resp.read(65536 + 1).decode("utf-8"))
    except ReadinessError:
        raise
    except Exception as exc:
        raise ReadinessError("upstream /v1/models unreachable (%s)" % type(exc).__name__) from exc
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list) or not data:
        raise ReadinessError("upstream listed no models")
    ids = [entry["id"] for entry in data
           if isinstance(entry, dict) and isinstance(entry.get("id"), str)]
    if not ids:
        raise ReadinessError("upstream listed no models")
    return clean_model_ids(ids)


def runtime_models_entry(runtime_name, models):
    """Shape one capability runtimes[] entry's models extension.

    Returns {"models": [ids]} for attachment by the report builder, or {}
    when the runtime name is outside the qualified set (never mapped).
    """
    if runtime_name not in READINESS_RUNTIMES:
        return {}
    return {"models": clean_model_ids(models)}
