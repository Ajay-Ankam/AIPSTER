"""AIPSTER hardware-qualification assignment checks (meta-qual lane).

Stdlib only. Validates a hosted benchmark assignment and local readiness
before anything executes. Untrusted assignment JSON is refused with
QualificationError; nothing here performs inference.
"""

import time
from datetime import datetime, timezone

CATALOG_ID = "completion-smoke-v1"
CATALOG_VERSION = "qual-catalog-v1"
RUNTIME_ALLOWLIST = ("ganglion", "llama-server")
ASSIGNMENT_MAX_TOKENS = 32
DEADLINE_MS = 15_000

PROFILE_DIGEST_RE_LEN = 64


class QualificationError(ValueError):
    """Refusal to accept or run a benchmark assignment."""


def _is_id(value):
    return isinstance(value, str) and 1 <= len(value) <= 128


def validate_assignment(raw):
    """Strictly validate an assignment dict from the hosted server."""
    if not isinstance(raw, dict):
        raise QualificationError("assignment must be an object")
    allowed = {"runId", "nodeId", "profileDigest", "catalogVersion",
               "catalogId", "leaseId", "deadlineAt", "runtimeAllowlist",
               "maxTokens"}
    for key in raw:
        if key not in allowed:
            raise QualificationError("unknown assignment field %r" % (key,))
    for field in ("runId", "nodeId", "leaseId"):
        if not _is_id(raw.get(field)):
            raise QualificationError("%s must be a valid id" % field)
    digest = raw.get("profileDigest")
    if (not isinstance(digest, str) or len(digest) != PROFILE_DIGEST_RE_LEN
            or any(c not in "0123456789abcdef" for c in digest)):
        raise QualificationError("profileDigest must be sha256 hex")
    if raw.get("catalogVersion") != CATALOG_VERSION:
        raise QualificationError("catalogVersion mismatch")
    if raw.get("catalogId") != CATALOG_ID:
        raise QualificationError("catalogId is not the supported catalog")
    allow = raw.get("runtimeAllowlist")
    if (not isinstance(allow, list) or not allow
            or any(r not in RUNTIME_ALLOWLIST for r in allow)):
        raise QualificationError("runtimeAllowlist outside the CPU transport set")
    if raw.get("maxTokens") != ASSIGNMENT_MAX_TOKENS:
        raise QualificationError("maxTokens must be %d" % ASSIGNMENT_MAX_TOKENS)
    # Timezone-aware UTC only: time.mktime would read a UTC instant as local
    # time, so expiry would be wrong outside UTC. 'Z' and numeric offsets
    # both parse; a naive timestamp is refused, never assumed.
    text = raw.get("deadlineAt")
    if not isinstance(text, str) or not text.strip():
        raise QualificationError("deadlineAt must be ISO time")
    text = text.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        raise QualificationError("deadlineAt must be ISO time")
    if moment.tzinfo is None:
        raise QualificationError("deadlineAt must carry a timezone")
    _ = moment.astimezone(timezone.utc)
    return raw


def check_readiness(*, runtime_id, model_listed, mem_total_bytes,
                    mem_needed_bytes=1 << 30, now_ms=None, deadline_at=None):
    """Refuse the run when local readiness or bounds fail.

    Returns None on success; raises QualificationError otherwise.
    mem_needed_bytes defaults to 1 GiB of total RAM.
    """
    if runtime_id not in RUNTIME_ALLOWLIST:
        raise QualificationError("runtime %r is not in the CPU transport set"
                                 % (runtime_id,))
    if not model_listed:
        raise QualificationError("model is not listed ready upstream")
    if not isinstance(mem_total_bytes, int) or mem_total_bytes < mem_needed_bytes:
        raise QualificationError("insufficient total memory for the benchmark")
    if deadline_at is not None and now_ms is not None and now_ms >= deadline_at:
        raise QualificationError("assignment deadline already passed")
    return None
