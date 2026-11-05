"""Assignment poll -> fixed benchmark -> result post loop (meta-qual lane).

Opt-in only: nothing runs unless the operator starts `serve-qualification`
explicitly with --model-id naming the already-configured ready model.
Identity reuses the existing stored heartbeat pairing (api_base +
heartbeat_key + resource_id); no new credentials are minted, read, or
printed. The upstream must be loopback, the runtime one of the qualified
transports, and the model listed ready upstream under its configured
upstream_model identity with the served-model echo naming that identity
back — anything else is reported explicitly, never measured. This is a
generic local-native smoke test, not a hardware placement certificate:
placement travels as explicit provenance ('unknown' or
'operator-declared'), never as verified CPU. Managed execution is deferred
until native-alias binding is proven.

One benchmark at a time. A run id recorded in the durable started-ledger
before the upstream call is never executed again: after a crash its outcome
stays uncertain (posted as uncertain on recovery poll, never re-run), and a
second runner for the same data dir refuses to start.

Standard library only, like pairing.py and inference_worker.py.
"""

import argparse
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import pairing
from pairing import PairingError, RePairRequired
from inference_worker import _hold_lock, get_json

import qualification as qual
import benchmark as bench
from benchmark import BenchmarkError

QUAL_NEXT_PATH = "/api/worker/qualifications/next"
QUAL_RESULT_TMPL = "/api/worker/qualifications/{run_id}/result"
QUAL_LOCK_NAME = "qual.lock"
QUAL_LEDGER_NAME = "started-qual-runs.json"
QUAL_LEDGER_LIMIT = 256
QUAL_POLL_INTERVAL_SEC = 5.0
QUAL_MAX_IDLE_SEC = 60.0

# BenchmarkError.reason -> posted terminal status. Binding and support
# refusals are explicit unsupported; transport/execution errors are failed;
# timeouts (including an already-elapsed execution window) are timed_out.
STATUS_FOR_REASON = {
    "EXPIRED": "timed_out",
    "TIMED_OUT": "timed_out",
    "UPSTREAM_UNAVAILABLE": "failed",
    "UPSTREAM_ERROR": "failed",
    "NOT_READY": "unsupported",
    "MEMORY_UNVERIFIED": "unsupported",
    "RUNTIME_MISMATCH": "unsupported",
    "SIMULATED": "unsupported",
    "MODEL_MISMATCH": "unsupported",
    "BAD_DEADLINE": "unsupported",
    "BAD_CONFIG": "unsupported",
    "UNMEASURABLE": "unsupported",
    "UNVERIFIED": "unsupported",
    "BINDING_MISMATCH": "unsupported",
    "MANAGED_DEFERRED": "unsupported",
    "CLOCK_NAIVE": "failed",
}


def _default_config_loader(config_path):
    """Load the worker config with the vendored dendrite package."""
    from pathlib import Path as _Path
    try:
        from dendrite.config import load_config
    except ImportError as exc:
        raise BenchmarkError("UNVERIFIED",
                             "worker package unavailable for binding check") from exc
    return load_config(_Path(config_path))


_MISSING = object()

_LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


def _origin(url):
    """(scheme, host, port) for an http(s) URL, localhost normalized.

    Returns None when unparseable. Bracketed IPv6 hosts are un-bracketed by
    the parser; localhost is folded to 127.0.0.1 so textual aliases of one
    loopback endpoint compare equal. Distinct loopback addresses stay
    distinct: proximity is not identity.
    """
    try:
        from urllib.parse import urlsplit
        parts = urlsplit(url or "")
        host = (parts.hostname or "").lower()
        if host == "localhost":
            host = "127.0.0.1"
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if not parts.scheme or not host:
            return None
        return (parts.scheme.lower(), host, port)
    except (ValueError, TypeError, AttributeError):
        return None


def _is_loopback_origin(origin):
    return origin is not None and origin[0] == "http" \
        and origin[1] in _LOOPBACK_HOSTS


def _explicit_cpu_pins(config_path):
    """Runtime ids whose TOML entry explicitly pins `gpu_layers = 0`.

    The real worker schema defaults an absent gpu_layers to 0, so a loaded
    config cannot tell an operator's explicit CPU pin from an untouched
    default. Only an explicit pin counts as known CPU placement; a defaulted
    zero is unknown, never assumed CPU. Stdlib tomllib only, raw text of the
    same file the loader read. Unreadable config refuses closed.
    """
    import tomllib
    try:
        with open(config_path, "rb") as handle:
            doc = tomllib.load(handle)
    except (OSError, ValueError) as exc:
        raise BenchmarkError("UNVERIFIED",
                             "worker config TOML unreadable for placement check") from exc
    pins = set()
    runtimes = doc.get("runtimes")
    if not isinstance(runtimes, list):
        return pins
    for entry in runtimes:
        if not isinstance(entry, dict):
            continue
        layers = entry.get("gpu_layers", _MISSING)
        if layers is not _MISSING and not isinstance(layers, bool) \
                and layers == 0 and isinstance(entry.get("id"), str):
            pins.add(entry["id"])
    return pins


def verify_local_binding(*, config_path, data_dir, runtime_id, model_id,
                         ganglion_base=None, timeout=5.0, load_config=None,
                         attach_probe=None, managed_probe=None, which=None):
    """Require an observed configured local binding before execution.

    A model-listing plus a claimed runtime string cannot prove where the
    benchmark ran (a loopback proxy can serve a cloud alias, a GPU runtime,
    or an unconfigured model). This binds, in order:

    1. the operator's own worker config names the model on a runtime whose
       mode matches the claimed transport (ganglion=attach, llama-server=
       managed), whose kind is a real local kind (never mock; llama-server
       additionally requires the llama_cpp kind), and — for attach — whose
       configured model carries the schema-required upstream_model identity
       used for listing, request and served-echo comparison. Managed
       execution is explicitly deferred (MANAGED_DEFERRED): a worker-spawned
       engine serves a native alias the runner cannot yet map to the
       configured id, so managed never executes here — reported
       unsupported, never measured;
    2. the completion target is exactly the verified runtime's own
       loopback endpoint — the attach runtime's configured base_url, or
       the managed engine's loopback port. Anything else (including a
       Ganglion proxy in front of a managed engine, or an unrelated
       loopback proxy) is refused as BINDING_MISMATCH: locality of some
       other local worker proves nothing about this target;
    3. the RUNNING worker's authenticated loopback report for the relevant
       mode only (attach or managed, sharing this call's timeout) confirms
       that exact configured model resident/available, non-simulated, on
       a healthy runtime.

    Placement is NEVER certified here. An attach gpu_layers pin neither
    controls nor observes the external server's offload (dendrite uses it
    only to launch managed engines), so attach placement is recorded as
    provenance — 'operator-declared' for an explicit zero pin, 'unknown'
    otherwise — and carried into the result for honest display. A missing
    pin gates nothing on attach; it only labels.

    Returns an evidence dict. Anything unverifiable raises BenchmarkError
    (UNVERIFIED/BINDING_MISMATCH/NOT_READY/MANAGED_DEFERRED), which the
    caller reports as explicit unsupported — never asserted as hardware
    placement.
    """
    if runtime_id not in ("ganglion", "llama-server"):
        raise BenchmarkError("RUNTIME_MISMATCH",
                             "runtime outside the CPU transport set")
    if runtime_id == "llama-server":
        raise BenchmarkError("MANAGED_DEFERRED",
                             "managed execution deferred until native-alias "
                             "binding is proven; explicit unsupported")
    if not config_path:
        raise BenchmarkError("UNVERIFIED", "no worker config for binding check")
    using_default_loader = load_config is None
    loader = load_config or _default_config_loader
    try:
        config = loader(config_path)
    except BenchmarkError:
        raise
    except Exception as exc:
        raise BenchmarkError("UNVERIFIED",
                             "worker config failed to load") from exc
    # Production hole: the real schema fills a missing gpu_layers with 0, so
    # the loaded value alone cannot prove an explicit CPU pin. With the real
    # loader, consult the raw TOML too; injected test loaders carry
    # schema-faithful attribute presence on their own entries.
    pins = _explicit_cpu_pins(config_path) if using_default_loader else None
    want_mode = "attach" if runtime_id == "ganglion" else "managed"
    try:
        runtimes = list(getattr(config, "runtimes", None) or [])
        models = list(getattr(config, "models", None) or [])
    except TypeError:
        raise BenchmarkError("UNVERIFIED", "worker config has no runtimes")
    which_fn = which or __import__("shutil").which
    target = _origin(ganglion_base)
    if not _is_loopback_origin(target):
        raise BenchmarkError("BINDING_MISMATCH",
                             "completion target is not a loopback http endpoint")
    candidates = []
    endpoint_mismatch = False
    for entry in runtimes:
        mode = getattr(entry, "mode", "managed") or "managed"
        kind = getattr(entry, "kind", None)
        if mode != want_mode or kind == "mock" or not kind:
            continue
        if runtime_id == "llama-server" and kind != "llama_cpp":
            continue
        if want_mode == "attach":
            # The native upstream identity: listing, request and served echo
            # all speak it; the configured id is reported, never requested.
            # The schema requires upstream_model on attach models — absent
            # means unconfigured for the smoke test.
            upstream = None
            for model in models:
                if getattr(model, "runtime", None) != getattr(entry, "id", None) \
                        or getattr(model, "id", None) != model_id:
                    continue
                candidate = getattr(model, "upstream_model", None)
                if isinstance(candidate, str) and candidate:
                    upstream = candidate
                break
            if upstream is None:
                continue
            # Placement provenance only: an attach pin controls nothing, so
            # it gates nothing — explicit zero reads 'operator-declared',
            # anything else 'unknown'. Never a placement certificate.
            if pins is not None:
                declared = getattr(entry, "id", None) in pins
            else:
                layers = getattr(entry, "gpu_layers", _MISSING)
                declared = layers is not _MISSING \
                    and not isinstance(layers, bool) and layers == 0
            provenance = "operator-declared" if declared else "unknown"
        else:
            # Deferred scaffold (see the MANAGED_DEFERRED gate above): pin
            # gating and executable/kind/port checks for a future managed
            # path with proven alias binding.
            upstream = None
            provenance = "unknown"
            layers = getattr(entry, "gpu_layers", _MISSING)
            if layers is _MISSING or isinstance(layers, bool) or layers != 0:
                continue
            if pins is not None and getattr(entry, "id", None) not in pins:
                continue
            if not which_fn(getattr(entry, "executable", None) or ""):
                continue
            configured = any(getattr(m, "runtime", None) == getattr(entry, "id", None)
                             and getattr(m, "id", None) == model_id
                             for m in models)
            if not configured:
                continue
        if want_mode == "attach":
            endpoint = _origin(getattr(entry, "base_url", None))
            if endpoint is None or endpoint != target:
                endpoint_mismatch = True
                continue
        else:
            port = getattr(entry, "port", _MISSING)
            if port is _MISSING or not isinstance(port, int) \
                    or isinstance(port, bool) or target != ("http", target[1], port):
                endpoint_mismatch = True
                continue
        candidates.append((entry, upstream, provenance))
    if not candidates:
        if endpoint_mismatch:
            raise BenchmarkError("BINDING_MISMATCH",
                                 "completion target is not the verified "
                                 "runtime endpoint")
        raise BenchmarkError("UNVERIFIED",
                             "no configured local CPU runtime/model/endpoint binding")
    probe = attach_probe or pairing.attach_readiness if want_mode == "attach" \
        else managed_probe or pairing.managed_readiness
    ready = set(probe(config, data_dir, timeout)[0])
    for entry, upstream, provenance in candidates:
        if (getattr(entry, "id", None), model_id) in ready:
            return {"runtimeId": runtime_id,
                    "configRuntime": getattr(entry, "id", None),
                    "modelId": model_id, "upstreamModel": upstream,
                    "placementProvenance": provenance,
                    "mode": want_mode, "endpoint": "%s://%s:%d" % target}
    raise BenchmarkError("NOT_READY",
                         "running worker does not report the configured model ready")


class QualLedger:
    """Durable record of run ids handed to the upstream, written first.

    Same atomic pattern as inference_worker.StartedLedger, separate file so
    the two runners never share fate. A recorded run is never executed
    again; its outcome stays uncertain until a result post is confirmed.
    """

    def __init__(self, data_dir, limit=QUAL_LEDGER_LIMIT):
        self.path = Path(data_dir) / QUAL_LEDGER_NAME
        self.limit = limit
        self._ids = self._load()

    def _load(self):
        if not self.path.exists():
            return []
        try:
            record = __import__("json").loads(
                self.path.read_text(encoding="utf-8"))
            ids = record.get("run_ids") if isinstance(record, dict) else None
            if not isinstance(ids, list) or not all(
                    isinstance(v, str) and v for v in ids):
                raise ValueError("unexpected ledger shape")
            return ids
        except (OSError, ValueError) as exc:
            raise PairingError(None, "BAD_QUAL_LEDGER",
                               f"started-run ledger {self.path.name} is unreadable; "
                               "fix or remove it before serving qualifications") from exc

    def contains(self, run_id):
        return run_id in self._ids

    def record(self, run_id):
        if run_id in self._ids:
            return
        ids = (self._ids + [run_id])[-self.limit:]
        pairing.write_private(self.path,
                              __import__("json").dumps({"run_ids": ids},
                                                       indent=2) + "\n")
        self._ids = ids


def fetch_assignment(api_base, secret, timeout=pairing.REQUEST_TIMEOUT_SEC):
    """Poll one benchmark assignment. Returns (frame | None, retry_after)."""
    base = pairing.check_api_base(api_base)
    status, body, retry_after = get_json(base + QUAL_NEXT_PATH, secret,
                                         timeout)
    if status == 204:
        return None, retry_after
    if status == 200:
        return (body or None), retry_after
    err = body.get("code") or "QUAL_POLL_FAILED"
    msg = body.get("error") or f"assignment poll failed (HTTP {status})"
    if status in (401, 403) and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(status, err, msg)
    if status == 404:
        raise PairingError(status, err,
                           "qualification route unavailable server-side")
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def post_qual_result(api_base, run_id, secret, lease_id, status, result):
    """Post one benchmark result. Returns the accepted response body."""
    base = pairing.check_api_base(api_base)
    url = base + QUAL_RESULT_TMPL.format(run_id=quote(str(run_id), safe=""))
    code, body, retry_after = pairing.post_json(
        url, {"leaseId": lease_id, "status": status, "result": result},
        secret)
    err = body.get("code") or "QUAL_RESULT_FAILED"
    msg = body.get("error") or f"result post failed (HTTP {code})"
    if code in (200, 201, 202):
        return body
    if code in (401, 403) and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(code, err, msg)
    if code == 429:
        raise PairingError(code, err, msg, retry_after)
    raise PairingError(code, err, msg)


def _validate_frame(frame):
    """Accept only a complete assignment frame. Returns (run_id, lease_id,
    assignment, execution_deadline|None)."""
    if not isinstance(frame, dict):
        raise qual.QualificationError("assignment frame is not an object")
    run_id = frame.get("runId") or frame.get("run_id")
    lease_id = frame.get("leaseId") or frame.get("lease_id")
    assignment = frame.get("assignment")
    if not run_id or not lease_id or not isinstance(assignment, dict):
        raise qual.QualificationError("assignment frame lacks run/lease/assignment")
    exec_deadline = frame.get("executionDeadline") \
        or frame.get("execution_deadline")
    return run_id, lease_id, assignment, exec_deadline


class QualRunner:
    """Poll -> validate -> one fixed benchmark -> result post, with ledger."""

    def __init__(self, data_dir, model_id, runtime_id="ganglion",
                 ganglion_base=None, ganglion_token=None,
                 allow_non_loopback=False, config_path=None,
                 poll_interval=QUAL_POLL_INTERVAL_SEC,
                 max_idle_sec=QUAL_MAX_IDLE_SEC,
                 sleep=None, clock=None, now=None,
                 fetch_fn=None, post_fn=None, mem_fn=None, bench_fn=None,
                 verify_fn=None):
        if not model_id or not isinstance(model_id, str):
            raise PairingError(None, "QUAL_NO_MODEL",
                               "--model-id must name the configured ready model")
        self.data_dir = Path(data_dir)
        self.model_id = model_id
        self.runtime_id = runtime_id
        self.ganglion_base = ganglion_base
        self.ganglion_token = ganglion_token
        self.allow_non_loopback = allow_non_loopback
        self.config_path = config_path
        self.poll_interval = max(0.001, float(poll_interval))
        self.max_idle = max(self.poll_interval, float(max_idle_sec))
        self.sleep = sleep or time.sleep
        self.clock = clock or time.monotonic
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.fetch_fn = fetch_fn or fetch_assignment
        self.post_fn = post_fn or post_qual_result
        self.mem_fn = mem_fn or pairing._memory_bytes
        self.bench_fn = bench_fn or bench.run_benchmark
        self.verify_fn = verify_fn or verify_local_binding
        self.ledger = None
        self._stop = threading.Event()

    def run(self, max_cycles=None):
        try:
            pairing.private_dir(self.data_dir)
            self.ledger = QualLedger(self.data_dir)
        except (PairingError, OSError) as exc:
            print(f"qual: [{getattr(exc, 'code', 'PRIVATE_STORAGE')}] {exc}",
                  file=sys.stderr)
            return pairing.EXIT_USAGE
        try:
            guard = _hold_lock(self.data_dir, QUAL_LOCK_NAME)
        except PairingError as exc:
            print(f"qual: [{exc.code}] {exc}", file=sys.stderr)
            return pairing.EXIT_USAGE
        if guard is None:
            print("qual: [QUAL_RUNNING] another serve-qualification already "
                  "holds this data dir; not starting a second",
                  file=sys.stderr)
            return pairing.EXIT_SENDER_RUNNING
        restore = self._install_stop_handlers()
        try:
            return self._loop(max_cycles)
        finally:
            restore()
            guard.release()

    def _install_stop_handlers(self):
        if os.name == "nt" or threading.current_thread() is not threading.main_thread():
            return lambda: None
        previous = {}

        def handler(signum, _frame):
            if self._stop.is_set():
                for sig, old in previous.items():
                    try:
                        signal.signal(sig, old if old is not None else signal.SIG_DFL)
                    except (OSError, ValueError, RuntimeError):
                        pass
                try:
                    signal.raise_signal(signum)
                except (AttributeError, OSError, RuntimeError):
                    raise KeyboardInterrupt
                return
            self._stop.set()

        for name in ("SIGTERM", "SIGINT"):
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                previous[sig] = signal.getsignal(sig)
                signal.signal(sig, handler)
            except (OSError, ValueError, RuntimeError):
                previous.pop(sig, None)

        def restore():
            for sig, old in previous.items():
                try:
                    signal.signal(sig, old if old is not None else signal.SIG_DFL)
                except (OSError, ValueError, RuntimeError):
                    pass

        return restore

    def _loop(self, max_cycles):
        cycles = 0
        idle = 0
        failures = 0
        while max_cycles is None or cycles < max_cycles:
            if self._stop.is_set():
                print("qual: stop requested; no run was re-executed",
                      file=sys.stderr)
                return pairing.EXIT_OK
            cycles += 1
            try:
                with pairing.pair_lock(self.data_dir):
                    meta = pairing.load_pairing(self.data_dir)
            except PairingError as exc:
                if exc.code == "PAIR_IN_PROGRESS":
                    self.sleep(self.poll_interval)
                    continue
                print(f"qual: [{exc.code}] {exc}", file=sys.stderr)
                return pairing.EXIT_REPAIR_REQUIRED if exc.code == "NOT_PAIRED" \
                    else pairing.EXIT_USAGE
            try:
                frame, retry_after = self.fetch_fn(meta["api_base"],
                                                   meta["heartbeat_key"])
            except RePairRequired as exc:
                print(f"qual: [{exc.code}] worker key is dead; pair again",
                      file=sys.stderr)
                return pairing.EXIT_REPAIR_REQUIRED
            except PairingError as exc:
                if exc.status == 429:
                    self.sleep(exc.retry_after or self.poll_interval)
                    continue
                failures += 1
                if failures > pairing.MAX_ATTEMPTS_NETWORK:
                    print(f"qual: giving up after {pairing.MAX_ATTEMPTS_NETWORK} "
                          f"tries: [{exc.code}] {exc}", file=sys.stderr)
                    return pairing.EXIT_NETWORK
                wait = min(2 ** failures, 60)
                print(f"qual: [{exc.code}] {exc}; retry {failures}/"
                      f"{pairing.MAX_ATTEMPTS_NETWORK} in {wait}s",
                      file=sys.stderr)
                self.sleep(wait)
                continue
            failures = 0
            if frame is None:
                idle = min(idle + 1, 10)
                self.sleep(retry_after or min(
                    self.poll_interval * (2 ** idle), self.max_idle))
                continue
            idle = 0
            try:
                stop = self._handle(meta, frame)
            except RePairRequired as exc:
                print(f"qual: [{exc.code}] worker key is dead; pair again",
                      file=sys.stderr)
                return pairing.EXIT_REPAIR_REQUIRED
            except Exception as exc:
                # One unexpected run fault must not kill the loop or lose
                # the lease accounting: the run stays non-terminal, so the
                # recovery poll can redeliver it (the started-ledger still
                # guards against double execution).
                print(f"qual: [UNEXPECTED {type(exc).__name__}] {exc}; "
                      "run left for recovery", file=sys.stderr)
                failures += 1
                if failures > pairing.MAX_ATTEMPTS_NETWORK:
                    print(f"qual: giving up after {pairing.MAX_ATTEMPTS_NETWORK} "
                          "consecutive faults", file=sys.stderr)
                    return pairing.EXIT_NETWORK
                self.sleep(min(2 ** failures, 60))
                continue
            if stop is not None:
                return stop
        return pairing.EXIT_OK

    def _handle(self, meta, frame):
        """Poll -> benchmark -> post one assignment. Returns stop or None."""
        try:
            run_id, lease_id, assignment, exec_deadline = _validate_frame(frame)
            qual.validate_assignment(assignment)
        except qual.QualificationError as exc:
            print(f"qual: [ASSIGNMENT_INVALID] {exc}; nothing posted",
                  file=sys.stderr)
            return None
        if self.ledger.contains(run_id):
            # Already handed to the upstream: the earlier result was never
            # confirmed, so this run is uncertain — post that, never re-run.
            print(f"qual: {run_id} already started; posting uncertain, "
                  "not re-executed", file=sys.stderr)
            return self._post(meta, run_id, lease_id, "uncertain",
                              {"reason": "UNCONFIRMED_PRIOR_RUN"})
        # Local binding first: a listing plus a claimed name cannot prove
        # where execution happens, so nothing reaches the upstream (and the
        # ledger) until the operator's own config plus the running worker's
        # report verify this exact model on its exact endpoint. Placement is
        # recorded as provenance, never certified. Refusals post explicit
        # unsupported without consuming the run.
        exec_remaining = None
        if exec_deadline is not None:
            try:
                until = bench.parse_deadline(exec_deadline)
            except qual.QualificationError as exc:
                return self._post(meta, run_id, lease_id, "unsupported",
                                  {"reason": "BAD_DEADLINE",
                                   "detail": str(exc)})
            exec_remaining = (until - self.now()).total_seconds()
            if exec_remaining <= 0:
                return self._post(meta, run_id, lease_id, "timed_out",
                                  {"reason": "EXPIRED",
                                   "detail": "window elapsed before verification"})
        try:
            binding = self.verify_fn(
                config_path=self.config_path, data_dir=str(self.data_dir),
                runtime_id=self.runtime_id, model_id=self.model_id,
                ganglion_base=self.ganglion_base,
                timeout=max(1.0, min(5.0, exec_remaining))
                if exec_remaining is not None else 5.0)
        except BenchmarkError as exc:
            print(f"qual: {run_id} unsupported [{exc.reason}]"
                  + (f" ({exc.detail})" if exc.detail else ""),
                  file=sys.stderr)
            return self._post(meta, run_id, lease_id, "unsupported",
                              {"reason": exc.reason,
                               **({"detail": exc.detail} if exc.detail else {})})
        try:
            self.ledger.record(run_id)
        except (PairingError, OSError):
            print(f"qual: {run_id} [BAD_QUAL_LEDGER] cannot record the "
                  "started run; refusing to execute", file=sys.stderr)
            return pairing.EXIT_USAGE
        mem = self.mem_fn()
        mem_total = mem[0] if mem else None
        mem_avail = mem[1] if mem else None
        try:
            result = self.bench_fn(
                assignment=assignment, model_id=self.model_id,
                runtime_id=self.runtime_id, base_url=self.ganglion_base,
                token=self.ganglion_token, mem_total_bytes=mem_total,
                mem_avail_bytes=mem_avail, clock=self.clock, now=self.now(),
                exec_deadline=exec_deadline,
                upstream_model=binding.get("upstreamModel"),
                placement_provenance=binding.get("placementProvenance"))
        except BenchmarkError as exc:
            status = STATUS_FOR_REASON.get(exc.reason, "failed")
            print(f"qual: {run_id} {status} [{exc.reason}]"
                  + (f" ({exc.detail})" if exc.detail else ""),
                  file=sys.stderr)
            return self._post(meta, run_id, lease_id, status,
                              {"reason": exc.reason,
                               **({"detail": exc.detail} if exc.detail else {})})
        except PairingError as exc:
            print(f"qual: {run_id} unsupported [{exc.code}] {exc}",
                  file=sys.stderr)
            return self._post(meta, run_id, lease_id, "unsupported",
                              {"reason": exc.code})
        return self._post(meta, run_id, lease_id, "succeeded", result)

    def _post(self, meta, run_id, lease_id, status, result):
        try:
            self.post_fn(meta["api_base"], run_id, meta["heartbeat_key"],
                         lease_id, status, result)
        except RePairRequired:
            raise
        except PairingError as exc:
            if exc.status == 409:
                print(f"qual: result for {run_id} refused (409 {exc.code}); "
                      "not retried", file=sys.stderr)
            else:
                print(f"qual: result for {run_id} unconfirmed [{exc.code}]"
                      + (f" (HTTP {exc.status})" if exc.status else "")
                      + "; the run stays uncertain", file=sys.stderr)
            return None
        print(f"qual: {run_id} {status} posted")
        return None


def cmd_serve_qualification(args):
    """`pairing.py serve-qualification`: poll, benchmark and post until stopped."""
    try:
        from inference_worker import default_ganglion_base
        data_dir = Path(args.data_dir) if args.data_dir else pairing.default_data_dir()
        runner = QualRunner(
            data_dir,
            model_id=args.model_id,
            runtime_id=args.runtime_id,
            config_path=args.config,
            ganglion_base=args.ganglion_base or default_ganglion_base(),
            ganglion_token=os.environ.get("AIPSTER_GANGLION_TOKEN") or None,
            allow_non_loopback=args.allow_non_loopback_ganglion,
            poll_interval=args.interval)
        return runner.run(max_cycles=1 if args.once else None)
    except PairingError as exc:
        print(f"qual failed [{exc.code}]: {exc}", file=sys.stderr)
        return pairing.EXIT_USAGE


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="AIPSTER qualification benchmark runner (uses stored pairing)")
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--config", default=None,
                        help="worker config file used to verify the local CPU "
                             "runtime/model binding before every run")
    parser.add_argument("--model-id", required=True,
                        help="already-configured ready model to benchmark "
                             "(requested upstream under its upstream_model)")
    parser.add_argument("--runtime-id", default="ganglion",
                        help="runtime identity this worker claims: ganglion or "
                             "llama-server (default ganglion; managed is "
                             "deferred and reports unsupported)")
    parser.add_argument("--ganglion-base", "--upstream-url", dest="ganglion_base",
                        default=None,
                        help="local upstream base URL (default http://127.0.0.1:8471)")
    parser.add_argument("--allow-non-loopback-ganglion", action="store_true",
                        help="permit a non-loopback upstream base (not qualified)")
    parser.add_argument("--interval", type=float, default=QUAL_POLL_INTERVAL_SEC)
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    return cmd_serve_qualification(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
