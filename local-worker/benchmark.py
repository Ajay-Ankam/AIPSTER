"""Fixed completion-smoke-v1 native smoke benchmark (meta-qual lane).

Runs exactly one bounded local completion through the real inference-worker
adapter (GanglionClient): fixed synthetic prompt, temperature 0, at most 32
generated tokens, the assignment's remaining execution budget, one concurrent
benchmark per worker, operator-configured ready model only. No installs,
downloads, commands, URLs, flags or GPU use.

Listing, request and served-echo comparison speak the NATIVE upstream
identity: when the caller passes the config's upstream_model (attach
transports), the configured model id is reported but never requested — the
upstream is asked for the upstream identity and its echo must name that
identity back. The result carries both the configured modelId and the
actually-served servedModelId, plus an explicit placementProvenance
('unknown' or 'operator-declared'). This is a generic local-native smoke
test, never a hardware placement certificate.

Throughput comes only from the backend's own coherent native timing pairs
(usage.timings predicted_n/predicted_ms for generation and prompt_n/
prompt_ms for prefill, mirroring vendor/eif/dendrite/performance.py) — never
from wall-clock division. A completion the upstream marks simulated, or one
whose served-model echo does not name the requested native identity, is
refused as unmeasurable, never reported as a real measurement.

Stdlib only. Returns a bounded result dict; failures raise BenchmarkError
with a stable reason the caller maps to failed/timed_out/unsupported.
"""

import math
import time
from datetime import datetime, timezone

from pairing import PairingError
from inference_worker import (  # real local inference adapter, reused as-is
    EMPTY_CONTENT,
    FINISH_REASONS,
    GanglionClient,
    GanglionError,
    GANGLION_MODELS_TIMEOUT_SEC,
    GANGLION_TIMEOUT,
    GANGLION_UNAVAILABLE,
    check_ganglion_base,
    check_runtime_id,
    get_json,
)

import qualification as qual

BENCHMARK_CATALOG_ID = "completion-smoke-v1"
FIXED_PROMPT = "Summarize in one short sentence: the local benchmark is running."
MAX_TOKENS = 32
PROMPT_MAX_TOKENS = 128
MIN_AVAIL_BYTES = 256 * 1024 * 1024
MIN_TOTAL_BYTES = 1024 ** 3


class BenchmarkError(Exception):
    def __init__(self, reason, detail=""):
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


def _is_num(value):
    """Real numbers only: bools, NaN and infinities are not measurements."""
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def _tps(count, milliseconds):
    """Tokens/sec for one coherent native pair, else None.

    Mirrors vendor/eif/dendrite/performance.py: finite numbers, non-negative
    counts, strictly positive durations.
    """
    if not _is_num(count) or not _is_num(milliseconds):
        return None
    if count < 0 or milliseconds <= 0:
        return None
    return count * 1000.0 / milliseconds


def _count(value, maximum, name):
    """A reported token count: valid int in range, None when absent.

    Present-but-invalid counts raise UNMEASURABLE: a corrupt measurement
    must never ride along a success label.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise BenchmarkError("UNMEASURABLE", "%s is not an integer" % name)
    if value < 0 or value > maximum:
        raise BenchmarkError("UNMEASURABLE",
                             "%s outside the catalog bound" % name)
    return value


def _check_pairs(timings, completion_tokens=None, prompt_tokens=None):
    """Validate one timings object; present-but-incoherent raises."""
    if not isinstance(timings, dict):
        raise BenchmarkError("UNMEASURABLE", "timings is not an object")
    predicted_n = timings.get("predicted_n")
    predicted_ms = timings.get("predicted_ms")
    prompt_n = timings.get("prompt_n")
    prompt_ms = timings.get("prompt_ms")
    if _tps(predicted_n, predicted_ms) is None:
        raise BenchmarkError("UNMEASURABLE", "incoherent generation pair")
    if _tps(prompt_n, prompt_ms) is None:
        raise BenchmarkError("UNMEASURABLE", "incoherent prefill pair")
    if predicted_n > MAX_TOKENS:
        raise BenchmarkError("UNMEASURABLE", "more than the catalog maximum")
    for value in (predicted_n, prompt_n):
        if isinstance(value, float) and not value.is_integer():
            raise BenchmarkError("UNMEASURABLE", "fractional token count")
    if completion_tokens is not None and int(completion_tokens) != int(predicted_n):
        raise BenchmarkError("UNMEASURABLE", "completion count disagrees")
    if prompt_tokens is not None and int(prompt_tokens) != int(prompt_n):
        raise BenchmarkError("UNMEASURABLE", "prompt count disagrees")
    return {
        "promptN": int(prompt_n),
        "promptMs": float(prompt_ms),
        "predictedN": int(predicted_n),
        "predictedMs": float(predicted_ms),
    }


def native_timings(usage, completion_tokens=None, prompt_tokens=None, extra=None):
    """Coherent native timing pairs from usage.timings, else None.

    Preserves both the prefill (prompt_n/prompt_ms) and generation
    (predicted_n/predicted_ms) pairs when valid. When the usage object
    carries no timings key, a top-level completion timings object
    (direct-llama shape) is accepted as the observed fallback. A
    present-but-incoherent timings object in EITHER channel (bad types,
    NaN/inf, negatives, non-positive durations, non-integral or
    over-catalog counts, or counts disagreeing with the reported token
    counts) raises UNMEASURABLE instead of degrading to an unmeasured
    success — the fallback never papers over bad measurements. Absent
    everywhere returns None (unmeasured, shown as not-shown downstream —
    never a throughput source).
    """
    if isinstance(usage, dict) and "timings" in usage:
        return _check_pairs(usage.get("timings"), completion_tokens,
                            prompt_tokens)
    if isinstance(extra, dict):
        return _check_pairs(extra, completion_tokens, prompt_tokens)
    return None


class ObservedClient(GanglionClient):
    """GanglionClient that preserves the raw upstream bodies it saw.

    inference_worker.complete() keeps only content/usage/finish_reason; the
    benchmark boundary additionally needs the served-model echo and any
    simulation marking to refuse mock or alias responses as unmeasurable.
    This subclasses without modifying the existing worker.

    models() is bounded by the phase budget: the fixed readiness timeout is
    capped to the assignment's remaining time, so readiness plus execution
    can never exceed the total call budget.
    """

    def __init__(self, *args, phase_deadline=None, models_timeout=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.seen = []
        self.phase_deadline = phase_deadline
        self.models_timeout = (GANGLION_MODELS_TIMEOUT_SEC
                               if models_timeout is None else models_timeout)

    def models(self):
        """Listed model ids, bounded by the phase budget when set.

        Same semantics as GanglionClient.models (brief cache, no empty
        list); only the transport timeout is capped to the remaining phase
        budget, and an already-elapsed budget refuses without touching the
        wire. Raises GanglionError like the parent.
        """
        now = self.clock()
        if self._models is not None and now - self._models_at < self.models_cache_ttl:
            return self._models
        timeout = self.models_timeout
        if self.phase_deadline is not None:
            remaining = self.phase_deadline - now
            if remaining <= 0:
                raise GanglionError("DEADLINE_EXCEEDED",
                                    "assignment budget elapsed before readiness")
            timeout = min(timeout, remaining)
        try:
            status, body, _ = get_json(self.base + "/v1/models", self.token,
                                       timeout=timeout)
        except PairingError as exc:
            raise GanglionError(GANGLION_UNAVAILABLE, f"models {exc.code}") from exc
        if status != 200:
            raise GanglionError(GANGLION_UNAVAILABLE, f"models HTTP {status}")
        data = body.get("data")
        ids = [entry["id"] for entry in data
               if isinstance(entry, dict) and isinstance(entry.get("id"), str)] \
            if isinstance(data, list) else []
        if not ids:
            raise GanglionError(GANGLION_UNAVAILABLE, "no listed models")
        self._models, self._models_at = ids, now
        return ids

    def _post(self, path, payload, deadline_monotonic):
        status, body = super()._post(path, payload, deadline_monotonic)
        self.seen.append({"path": path, "status": status,
                          "body": body if isinstance(body, dict) else {}})
        return status, body


def _served_model(client):
    """The model id the upstream response actually names, else None."""
    for entry in reversed(client.seen):
        body = entry.get("body")
        if isinstance(body, dict) and isinstance(body.get("model"), str) \
                and body["model"]:
            return body["model"]
    return None


def _served_simulated(client):
    """True only when the upstream explicitly marks the output simulated."""
    for entry in reversed(client.seen):
        body = entry.get("body")
        if isinstance(body, dict) and body.get("simulated") is True:
            return True
    return False


def _completion_body(client):
    """The last completion response body this client saw, else None.

    ObservedClient records every upstream body, so a structurally valid but
    empty completion stays available for measurement without re-requesting.
    Non-observed clients offer nothing.
    """
    if not isinstance(client, ObservedClient):
        return None
    for entry in reversed(client.seen):
        if entry.get("path") in ("/v1/completions", "/v1/chat/completions"):
            body = entry.get("body")
            return body if isinstance(body, dict) else None
    return None


def _top_timings(client):
    """Top-level timings dict of the last completion body (direct-llama
    shape), else None. Observed evidence only — never synthesized."""
    body = _completion_body(client)
    if isinstance(body, dict) and isinstance(body.get("timings"), dict):
        return body["timings"]
    return None


def _recover_empty_output(client, native_id, original):
    """Salvage a measurement from a structurally valid empty completion.

    Reasoning models can spend the whole token cap on reasoning and return
    empty content: genuine native generation with nothing to show, whose
    throughput is measurable independent of answer quality. When the
    observed body is non-simulated, names the requested native identity,
    and carries a usage object with coherent timings, return that usage for
    the normal measurement path. Anything else re-raises the original
    failure or a more precise refusal: fabricated or absent measurements
    never become success.
    """
    body = _completion_body(client)
    if not isinstance(body, dict):
        raise BenchmarkError("UPSTREAM_ERROR", str(original))
    if body.get("simulated") is True:
        raise BenchmarkError("SIMULATED",
                             "upstream marked the output simulated")
    served = body.get("model")
    if not isinstance(served, str) or not served:
        raise BenchmarkError("MODEL_MISMATCH",
                             "upstream named no served model; unverifiable")
    if served != native_id:
        raise BenchmarkError("MODEL_MISMATCH",
                             "upstream served %r, not the requested native identity %r"
                             % (served, native_id))
    usage = body.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    # Empty content removes every other evidence of execution: without
    # coherent timings there is nothing genuine to measure.
    top = body.get("timings") if isinstance(body.get("timings"), dict) else None
    if native_timings(usage, None, None, top) is None:
        raise BenchmarkError("UPSTREAM_ERROR",
                             "%s; no valid timings to measure" % (original,))
    return usage


def parse_deadline(raw):
    """Timezone-aware UTC deadline from ISO text ('Z' or offset accepted)."""
    if not isinstance(raw, str) or not raw.strip():
        raise qual.QualificationError("deadlineAt must be ISO time")
    text = raw.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        raise qual.QualificationError("deadlineAt must be ISO time")
    if moment.tzinfo is None:
        raise qual.QualificationError("deadlineAt must carry a timezone")
    return moment.astimezone(timezone.utc)


PLACEMENT_PROVENANCE = ("unknown", "operator-declared")


def run_benchmark(*, assignment, model_id, runtime_id, base_url,
                  token=None, mem_total_bytes, mem_avail_bytes,
                  clock=None, now=None, client=None, client_factory=None,
                  exec_deadline=None, upstream_model=None,
                  placement_provenance=None):
    """Validate, execute once, and return the bounded result dict.

    mem_*_bytes are observed measurements (never CLI assertions). now is an
    aware UTC datetime (default: current time) so expiry is enforced against
    the assignment's own deadline, including non-UTC offsets. exec_deadline
    is the lease's execution deadline (ISO): when present the effective
    budget is the earlier of the two, so a stale queue window can never
    extend execution. upstream_model is the config's native identity for
    this model (attach): listing, request and echo all use it while the
    result still reports the configured modelId. placement_provenance is
    recorded verbatim only when it is 'unknown' or 'operator-declared';
    anything else degrades to 'unknown' — provenance can only under-claim,
    never certify placement.
    """
    qual.validate_assignment(assignment)
    try:
        check_runtime_id(runtime_id)
        if not base_url:
            raise BenchmarkError("BAD_CONFIG", "no upstream base configured")
        check_ganglion_base(base_url)
    except BenchmarkError:
        raise
    except Exception as exc:
        raise BenchmarkError("BAD_CONFIG", str(exc))
    if runtime_id not in assignment["runtimeAllowlist"]:
        raise BenchmarkError("RUNTIME_MISMATCH",
                             "runtime not in assignment allowlist")
    moment = now if now is not None else datetime.now(timezone.utc)
    if moment.tzinfo is None:
        raise BenchmarkError("CLOCK_NAIVE", "wall clock must be timezone-aware")
    try:
        deadline = parse_deadline(assignment.get("deadlineAt"))
        if exec_deadline is not None:
            lease_deadline = parse_deadline(exec_deadline)
            deadline = min(deadline, lease_deadline)
    except qual.QualificationError as exc:
        raise BenchmarkError("BAD_DEADLINE", str(exc))
    remaining = (deadline - moment).total_seconds()
    if remaining <= 0:
        raise BenchmarkError("EXPIRED", "assignment deadline already passed")
    if not isinstance(mem_total_bytes, int) \
            or mem_total_bytes < MIN_TOTAL_BYTES:
        raise BenchmarkError("MEMORY_UNVERIFIED",
                             "insufficient observed total memory")
    if isinstance(mem_avail_bytes, bool) \
            or not isinstance(mem_avail_bytes, int) \
            or mem_avail_bytes < MIN_AVAIL_BYTES:
        raise BenchmarkError("MEMORY_UNVERIFIED",
                             "insufficient observed available memory")
    if client is None:
        factory = client_factory or ObservedClient
        client = factory(base_url, token)
    tick = clock or time.monotonic
    # One absolute monotonic deadline for the whole phase, derived once:
    # readiness and execution share it, so a slow models() deducts from
    # complete() even when the wall-clock snapshot is fixed or re-read.
    phase_end = tick() + remaining
    if isinstance(client, ObservedClient):
        client.clock = tick
        client.phase_deadline = phase_end
    # The native request identity: the upstream identity when the caller
    # bound one (attach), else the configured id (legacy direct calls).
    native_id = upstream_model if isinstance(upstream_model, str) and upstream_model else model_id
    # An explicit binding carries provenance even when its native id is
    # identical to the configured id (the common installed-worker case).
    bound_path = isinstance(upstream_model, str) and bool(upstream_model)
    try:
        listed = client.models()
    except GanglionError as exc:
        raise BenchmarkError("UPSTREAM_UNAVAILABLE", str(exc))
    try:
        qual.check_readiness(runtime_id=runtime_id,
                             model_listed=native_id in listed,
                             mem_total_bytes=mem_total_bytes)
    except qual.QualificationError as exc:
        raise BenchmarkError("NOT_READY", str(exc))
    # Deduct what readiness consumed from the same absolute deadline —
    # never from a re-read wall clock, which would reset the budget.
    remaining = phase_end - tick()
    if remaining <= 0:
        raise BenchmarkError("EXPIRED", "assignment deadline passed during readiness")
    start = tick()
    served_echo = None
    try:
        out = client.complete(native_id, FIXED_PROMPT, MAX_TOKENS,
                              tick() + remaining)
    except GanglionError as exc:
        reason = getattr(exc, "reason", None)
        if reason in (GANGLION_TIMEOUT, "DEADLINE_EXCEEDED"):
            raise BenchmarkError("TIMED_OUT", str(exc))
        if reason == EMPTY_CONTENT:
            # Structurally valid but empty (reasoning-only generation at the
            # cap): measure from the observed body, or keep the failure.
            usage = _recover_empty_output(client, native_id, exc)
            body = _completion_body(client) or {}
            choices = body.get("choices")
            finish = None
            if isinstance(choices, list) and choices \
                    and isinstance(choices[0], dict):
                candidate = choices[0].get("finish_reason")
                if isinstance(candidate, str) and candidate in FINISH_REASONS:
                    finish = candidate
            out = {"usage": usage, "finish_reason": finish}
            served_echo = native_id
        else:
            raise BenchmarkError("UPSTREAM_ERROR", str(exc))
    if isinstance(client, ObservedClient) and served_echo is None:
        if _served_simulated(client):
            raise BenchmarkError("SIMULATED",
                                 "upstream marked the output simulated")
        served = _served_model(client)
        if served is None:
            raise BenchmarkError("MODEL_MISMATCH",
                                 "upstream named no served model; unverifiable")
        if served != native_id:
            raise BenchmarkError("MODEL_MISMATCH",
                                 "upstream served %r, not the requested native identity %r"
                                 % (served, native_id))
        served_echo = served
    elapsed_ms = int(max(0.0, (tick() - start) * 1000))
    usage = out.get("usage") if isinstance(out, dict) else {}
    if not isinstance(usage, dict):
        usage = {}
    prompt_tokens = _count(usage.get("prompt_tokens"), PROMPT_MAX_TOKENS,
                           "prompt_tokens")
    completion_tokens = _count(usage.get("completion_tokens"), MAX_TOKENS,
                               "completion_tokens")
    timings = native_timings(usage, completion_tokens, prompt_tokens,
                           _top_timings(client))
    if timings is None and completion_tokens is None:
        raise BenchmarkError("UNMEASURABLE", "no valid measurement returned")
    result = {
        "runtimeId": runtime_id,
        "modelId": model_id,
        "elapsedMs": elapsed_ms,
    }
    if bound_path:
        # Configured id reported, native identity actually served, and the
        # placement provenance that travelled with the binding. No key here
        # certifies hardware placement — see placement_provenance.
        if served_echo is not None:
            result["servedModelId"] = served_echo
        result["placementProvenance"] = placement_provenance \
            if placement_provenance in PLACEMENT_PROVENANCE else "unknown"
    if prompt_tokens is not None:
        result["promptTokens"] = prompt_tokens
    if completion_tokens is not None:
        result["completionTokens"] = completion_tokens
    if timings is not None:
        result["nativeTimings"] = timings
    finish = out.get("finish_reason") if isinstance(out, dict) else None
    if isinstance(finish, str) and finish:
        result["finishReason"] = finish
    return result
