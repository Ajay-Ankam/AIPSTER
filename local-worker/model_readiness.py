"""FABRIC067: worker-origin model readiness evidence (report helper only).

The fabric must route only to models a worker actually serves. The existing
capability schema (v1) reports runtime names, formats and memory, but no
model IDs, so the server cannot qualify placement from it. This module builds
the missing typed evidence from caller-supplied listed model IDs (the
pairing integration feeds already-probed attach results; this module performs
no network calls and takes no credentials, so there is no redirect or secret
surface here at all).

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
  * Model ids are bounded (1..256 chars, at most 64 per runtime,
    deduplicated, order-preserving).
  * No network, no keys, no prompts, no completions: pure shaping of
    already-observed lists.

Standard library only, like pairing.py.
"""

import time

READINESS_SCHEMA = "aipster-model-readiness/1"
READINESS_RUNTIMES = ("ganglion", "llama-server")
MODEL_ID_MAX = 256
MODELS_MAX = 64


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


def runtime_models_entry(runtime_name, models):
    """Shape one capability runtimes[] entry's models extension.

    Returns {"models": [ids]} for attachment by the report builder, or {}
    when the runtime name is outside the qualified set (never mapped).
    """
    if runtime_name not in READINESS_RUNTIMES:
        return {}
    return {"models": clean_model_ids(models)}
