"""One-time worker pairing + heartbeat sender for AIPSTER onboarding.

Protocol: docs/pairing.md and docs/heartbeat-intake.md. Standard library
only, so the installed launcher can freeze this module without new
dependencies and source installs can run it with any Python >= 3.11.

Flow:
  1. `pairing.py pair` — the user types the one-time code shown in the
     signed-in dashboard; the worker exchanges it for a resource row plus
     a resource-bound heartbeat key. The code itself is the account-linking
     approval: it can only be minted in an authenticated browser session.
  2. Credentials land in the user-private data dir (0600 + Windows user ACL)
     and are never printed, logged, or placed in URLs.
  3. `pairing.py heartbeat-loop` posts bounded reachability heartbeats.
     A heartbeat proves reachability, never inference readiness.

This module never serves inbound traffic and never touches the daemon's
loopback port: pairing is an outbound client (HTTPS, or loopback HTTP for
local tests only).
"""

import argparse
import contextlib
import getpass
import hashlib
import hmac
import http.client
import json
import os
import platform
import re
import secrets
import shutil
import socket
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

try:
    import msvcrt
except ImportError:  # POSIX: flock path below
    msvcrt = None
try:
    import fcntl
except ImportError:  # Windows: msvcrt path above
    fcntl = None

from private_storage_win32 import protect_path

DEFAULT_API_BASE = "https://aipster.net"
REQUEST_TIMEOUT_SEC = 15
# Product User-Agent (chain-release smoke, 2026-10-30): the API edge denies
# default scripting UAs (Cloudflare 1010), so every sender request identifies
# the worker explicitly. Verified live against /api/pairing/claim.
USER_AGENT = "AIPSTER-worker/1.0"
# Pair-mutex bound (Muse W3 round 11). A pair holds the lock across one
# claim (single bounded request) plus two local writes: seconds.
PAIR_LOCK_TIMEOUT_SEC = 180
HEARTBEAT_INTERVAL_SEC = 60
HEARTBEAT_MIN_INTERVAL_SEC = 30  # above the 25s server window + skew
MAX_ATTEMPTS_NETWORK = 5
STATUS_STALE_SEC = 5 * 60
PRIVATE_DIR_SETTLE_SEC = 2  # concurrent creator still normalizing its new directory
# Capability reports (opt-in, --report-capabilities). The catalog treats a
# snapshot older than CAPABILITY_FRESH_WINDOW_SEC as stale (mirrors
# estimate.mjs TELEMETRY_FRESH_MS; a website test pins the two together).
# Reports ride successful beats, so the real period is the beat grid
# rounded up — a fixed 240s target overshoots to 330s on 110s beats.
# The scheduler below targets the latest beat inside the window minus
# margin instead, so one missed beat cannot flip fresh to stale. Each
# report draws from the owner's shared hourly heartbeat budget
# (~15/h/node at defaults, <=30/h worst case).
CAPABILITY_INTERVAL_SEC = 240
CAPABILITY_FRESH_WINDOW_SEC = 300
CAPABILITY_STALE_MARGIN_SEC = 60
CAPABILITY_RETRY_SEC = 60
CAPABILITY_SCHEMA_VERSION = 1
# Config runtime kind -> reported runtime name. Named after the engine binary
# (the dispatch lane's runtime_id is also "llama-server"). Reporting a name is
# worker-declared evidence only; the catalog qualifies runtimes separately.
CAPABILITY_RUNTIME_NAMES = {"llama_cpp": "llama-server", "ik_llama": "ik_llama-server"}
CAPABILITY_FORMATS = ["gguf"]
MAX_SAFE_INT = 2 ** 53 - 1

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PAIRING_REJECTED = 3
EXIT_REPAIR_REQUIRED = 4
EXIT_NETWORK = 5
EXIT_SENDER_RUNNING = 6


class PairingError(Exception):
    """A failed pairing/heartbeat call. Never carries secret material."""

    def __init__(self, status, code, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


class RePairRequired(PairingError):
    """The stored sender key is revoked/expired: pair again with a new code."""


def check_api_base(raw):
    """Validate the API base. http is allowed for loopback test targets only."""
    try:
        parsed = urlparse(raw)
    except ValueError as exc:
        raise PairingError(None, "BAD_API_BASE", f"invalid API base: {exc}")
    if "@" in (parsed.netloc or ""):
        raise PairingError(None, "BAD_API_BASE", "credentials in the API base URL are refused")
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host:
        return raw.rstrip("/")
    if parsed.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        return raw.rstrip("/")
    raise PairingError(None, "BAD_API_BASE",
                        "API base must be https, or http loopback for local tests")


def default_data_dir():
    override = os.environ.get("AIPSTER_WORKER_DATA")
    if override:
        return Path(override)
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise PairingError(None, "NO_DATA_DIR",
                               "LOCALAPPDATA is not set; cannot locate the data directory")
        return Path(local) / "AIPSTER-Worker"
    return Path.home() / ".local" / "share" / "aipster-worker"


def _restrict_path(path, directory=False, *, new=False):
    """Establish private access; only exclusive creation permits new ownership."""
    path = Path(path)
    try:
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise OSError("linked worker state")
        if path.is_dir() != directory:
            raise OSError("unexpected worker state type")
        if os.name == "nt":
            protect_path(path, directory=directory, new=new)
        else:
            if path.stat().st_uid != os.getuid():
                raise OSError("worker state belongs to another user")
            os.chmod(path, 0o700 if directory else 0o600)
        return True
    except OSError as exc:
        raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage") from exc


def restrict_file(path, *, new=False):
    return _restrict_path(path, new=new)


def private_dir(path):
    path = Path(path)
    try:
        path.mkdir(mode=0o700)
        created = True
    except FileNotFoundError:
        private_dir(path.parent)
        return private_dir(path)
    except FileExistsError:
        created = False
    if created:
        if not _restrict_path(path, directory=True, new=True):
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        return path
    if os.name != "nt":
        # Existing POSIX directories are verified, never repaired. Silently
        # chmod-ing a directory (e.g. 0300 -> 0700) before enumerating managed
        # keys can mask a read failure and let destructive cleanup claim
        # completeness over a listing it could not fully read, so fail closed
        # on shared ownership instead and leave owner-only modes untouched.
        try:
            if path.is_symlink():
                raise OSError("linked worker state")
            if not path.is_dir():
                raise OSError("unexpected worker state type")
            if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
                raise OSError("shared worker state")
        except OSError as exc:
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage") from exc
        return path
    # Another process may have created the directory an instant ago and still
    # be replacing the token's default owner (e.g. Administrators on an
    # elevated token) with the user. Only that exact state is waited out,
    # briefly; any other owner fails on the first check, and the final check
    # is the same strict one, so nothing is adopted or loosened.
    deadline = time.monotonic() + PRIVATE_DIR_SETTLE_SEC
    while True:
        try:
            if _restrict_path(path, directory=True, new=False):
                return path
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        except PairingError as exc:
            if not _creator_still_settling(exc.__cause__) or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _creator_still_settling(cause):
    """True only while a new directory still carries this process's default owner."""
    default_owner = getattr(cause, "default_owner_sid", "unavailable")
    return (getattr(cause, "reason", None) == "owner-mismatch"
            and default_owner not in ("unavailable", getattr(cause, "user_sid", None))
            and getattr(cause, "owner_sid", None) == default_owner)


def write_private(path, text):
    """Atomic publication: protect an exclusively new empty file before bytes."""
    path = Path(path)
    private_dir(path.parent)
    if path.exists() and not restrict_file(path):
        raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if not restrict_file(tmp, new=True):
                raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def ensure_private_dir(path):
    """Compatibility name for the fail-closed private directory writer."""
    return private_dir(path)


def check_private_store(data_dir, key_path=None):
    """Verify without repairing a credential-routing manifest or selected key."""
    data = Path(data_dir)
    paths = [path for path in [data, data / "pairing.json", key_path] if path is not None and path.exists()]
    try:
        for path in paths:
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                raise OSError("linked store")
            if os.name == "nt":
                protect_path(path, directory=path == data, verify=True)
            elif path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
                raise OSError("shared store")
    except OSError as exc:
        raise PairingError(None, "BAD_PAIRING_STORE", "worker storage is not user-private; fix permissions or re-pair") from exc


def load_or_create_node_id(state_dir):
    """Stable worker identity (1..64 id chars), created once and kept."""
    state_dir = Path(state_dir)
    private_dir(state_dir)
    node_file = state_dir / "node-id"
    if node_file.exists():
        if not restrict_file(node_file):
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        value = node_file.read_text(encoding="utf-8").strip()
        if value and len(value) <= 64 and all(c.isalnum() or c in "-_" for c in value):
            return value
        raise PairingError(None, "BAD_NODE_ID",
                           f"{node_file} does not hold a valid node id; "
                           "delete it to generate a fresh one on next pair")
    # First-pair creation is exclusive: the id is fully written to a private
    # temp file, then hard-linked into place, which fails if another racer
    # already published one. Losers read the winner's complete file, so
    # concurrent first pairs converge on one identity and never overwrite it.
    value = "n_" + secrets.token_hex(16)
    fd, tmp = tempfile.mkstemp(dir=str(state_dir), prefix="node-id.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if not restrict_file(tmp, new=True):
                raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
            handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp, node_file)
        except FileExistsError:
            return load_or_create_node_id(state_dir)
        except OSError as exc:
            # No hard links here: refuse rather than fall back to a
            # non-exclusive replace that could overwrite a racer's identity.
            raise PairingError(None, "PRIVATE_STORAGE",
                               "worker storage does not support exclusive node-id creation") from exc
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return value


def probe_hardware(config_path=None):
    """Conservative capability discovery. Never claims what it cannot see.

    With the installed worker importable, hardware comes from dendrite's own
    discovery plus the configured models' capabilities. Otherwise (plain
    interpreter, tests) platform fallbacks apply and capabilities stay empty.
    GPU is reported only with positive evidence; mock engines contribute no
    capabilities because simulated execution is not real capacity.
    """
    snapshot = {
        "name": platform.node() or "worker",
        "kind": "local",
        "cpu": platform.processor() or "unknown",
        "gpu": "none recorded",
        "capabilities": [],
    }
    try:
        from dendrite.hardware import discover_hardware
    except ImportError:
        return snapshot
    try:
        hw = discover_hardware()
    except Exception:
        return snapshot
    gpus = hw.get("gpus") or []
    if gpus:
        first = gpus[0]
        snapshot["gpu"] = str(first.get("name") or "gpu")
    if hw.get("cpu"):
        snapshot["cpu"] = str(hw["cpu"])[:80]
    if config_path:
        try:
            from dendrite.config import load_config
            config = load_config(Path(config_path))
            kinds = {}
            for runtime in getattr(config, "runtimes", []) or []:
                kinds[getattr(runtime, "id", None)] = getattr(runtime, "kind", "")
            caps = []
            for model in getattr(config, "models", []) or []:
                # Per-model filtering (Codex P2): a mixed config must not
                # advertise mock-backed models as real capacity, and models
                # on unknown runtimes claim nothing.
                if kinds.get(getattr(model, "runtime", None), "mock") == "mock":
                    continue
                for cap in getattr(model, "capabilities", []) or []:
                    if cap not in caps:
                        caps.append(str(cap))
            snapshot["capabilities"] = caps[:20]
        except Exception:
            snapshot["capabilities"] = []
    return snapshot


ATTACH_PROBE_TIMEOUT_SEC = 3.0
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _worker_token(config, data_dir):
    """The local worker's API token: its env var first, then the data dir file.

    Same precedence as the Windows launcher. Read only; never generated here.
    """
    name = getattr(getattr(config, "node", None), "token_env", None)
    if name and os.environ.get(name):
        return os.environ[name]
    if not data_dir:
        return None
    try:
        value = (Path(data_dir) / "api-token.txt").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


ATTACH_NODE_MAX_BYTES = 1_048_576


def _is_str(value):
    return isinstance(value, str) and bool(value)


def attach_readiness(config, data_dir, timeout=ATTACH_PROBE_TIMEOUT_SEC):
    """(ready, reason) for configured attach models, from the RUNNING worker.

    Readiness comes from the worker's own authenticated loopback
    `GET /v1/node`, so the bit also proves the worker that would execute is
    up and has already applied its attach quarantine/identity checks. A model
    counts only when the node reports it available, resident and not
    simulated, and its runtime as attach, ready, without last_error and not
    simulated. `ready` is a set of (runtime_id, model_id).

    Never raises. Any error, non-loopback listener, missing token, redirect,
    oversized body or unexpected shape yields an empty set with a fixed,
    secret-free `reason` (no token, no response bytes) for the sender log.
    """
    try:
        return _attach_readiness(config, data_dir, timeout)
    except Exception as exc:  # fail closed: a probe bug must not stop the sender
        return set(), f"attach probe error ({type(exc).__name__})"


def _fetch_node_report(config, data_dir, timeout):
    """(report, reason): the running worker's authenticated loopback /v1/node.

    `report` is a dict with `runtimes` and `models` lists, or None with a
    fixed secret-free reason. Never logs the token or response bytes.
    """
    node = getattr(config, "node", None)
    host = str(getattr(node, "host", "") or "")
    port = getattr(node, "port", None)
    if host in ("0.0.0.0", "::", ""):
        host = "127.0.0.1"
    if host not in _LOOPBACK_HOSTS or not isinstance(port, int) or isinstance(port, bool):
        return None, "worker listener is not loopback; readiness not probed"
    token = _worker_token(config, data_dir)
    if not token:
        return None, "worker API token unavailable; readiness not probed"
    connection = None
    try:
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
        connection.request("GET", "/v1/node", headers={
            "Authorization": "Bearer " + token, "Accept": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            return None, f"worker /v1/node returned HTTP {int(response.status)}"
        raw = response.read(ATTACH_NODE_MAX_BYTES + 1)
    except (OSError, http.client.HTTPException) as exc:
        return None, f"worker /v1/node unreachable ({type(exc).__name__})"
    finally:
        if connection is not None:
            connection.close()
    if len(raw) > ATTACH_NODE_MAX_BYTES:
        return None, "worker /v1/node response too large"
    try:
        report = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "worker /v1/node response is not JSON"
    if not isinstance(report, dict):
        return None, "worker /v1/node response is not an object"
    if not isinstance(report.get("runtimes"), list) or not isinstance(report.get("models"), list):
        return None, "worker /v1/node response lacks runtimes/models lists"
    return report, "worker /v1/node ok"


def _attach_readiness(config, data_dir, timeout):
    report, reason = _fetch_node_report(config, data_dir, timeout)
    if report is None:
        return set(), reason
    runtimes, models = report["runtimes"], report["models"]
    configured = {r.id for r in getattr(config, "runtimes", []) or []
                  if getattr(r, "mode", "") == "attach" and getattr(r, "kind", "") != "mock"}
    # Only models THIS config selects, with the upstream identity it selects:
    # a worker started from an older config (same ids, different
    # upstream_model) or reporting removed models must not count.
    wanted = {(getattr(m, "runtime", None), getattr(m, "id", None)):
              getattr(m, "upstream_model", None)
              for m in getattr(config, "models", []) or []
              if getattr(m, "runtime", None) in configured}
    reported, live = set(), {}
    for runtime in runtimes:
        if not isinstance(runtime, dict) or not _is_str(runtime.get("id")):
            continue
        rid = runtime["id"]
        if rid not in configured:
            continue
        reported.add(rid)
        if (runtime.get("mode") == "attach" and runtime.get("state") in ("ready", "generating")
                and runtime.get("simulated") is False and not runtime.get("last_error")):
            live[rid] = runtime
    if not reported:
        return set(), "no configured attach runtime in worker report"
    if not live:
        return set(), "attach runtime not ready (state/error/simulated)"
    ready, stale = set(), False
    for model in models:
        if not isinstance(model, dict):
            continue
        rid, mid = model.get("runtime"), model.get("id")
        if not (_is_str(rid) and _is_str(mid) and rid in live and (rid, mid) in wanted
                and model.get("available") is True and model.get("resident") is True
                and model.get("simulated") is False):
            continue
        upstream = wanted[(rid, mid)]
        runtime = live[rid]
        if (_is_str(upstream) and runtime.get("loaded_model") == mid
                and runtime.get("model_fingerprint") == "attached:" + upstream):
            ready.add((rid, mid))
        else:
            stale = True
    if not ready:
        if stale:
            return set(), "attach model identity does not match config (restart the worker)"
        return set(), "attach runtime ready but no configured model resident/available"
    return ready, "attach model ready"


MANAGED_LIVE_STATES = ("unloaded", "loading", "ready", "generating")
"""Runtime states that count as managed capacity, from the vendored lifecycle
(dendrite runtimes/base.py: "unloaded" initial/cold, "ready"; runtimes/llama.py:
"loading" transient startup, "ready"; both use "generating" while serving).
Cold/on-demand runtimes stay usable without residency; "loading" is a genuine
transient, not a failure. "unavailable"/"error" are failure states; anything
else (missing, null, non-string, unknown) is a malformed report: fail closed."""


def managed_readiness(config, data_dir, timeout=ATTACH_PROBE_TIMEOUT_SEC):
    """(ready, reason) for configured MANAGED models, from the RUNNING worker.

    A managed model is cold until requested, so this does not require it to
    be resident: the running worker's /v1/node must list it available and
    not simulated (dendrite's own file + executable check) on a configured
    managed, non-simulated runtime whose reported state is an explicit live
    lifecycle state (MANAGED_LIVE_STATES). Failure states ("unavailable",
    "error") and any malformed state (missing, null, non-string, unknown)
    fail closed. This makes the usable bit false while the worker daemon is
    down or restarting. Never raises.
    """
    try:
        report, reason = _fetch_node_report(config, data_dir, timeout)
        if report is None:
            return set(), reason
        configured = {r.id for r in getattr(config, "runtimes", []) or []
                      if getattr(r, "mode", "") == "managed" and getattr(r, "kind", "") != "mock"}
        live = set()
        for runtime in report["runtimes"]:
            if (isinstance(runtime, dict) and _is_str(runtime.get("id"))
                    and runtime["id"] in configured and runtime.get("mode") == "managed"
                    and runtime.get("simulated") is False
                    and runtime.get("state") in MANAGED_LIVE_STATES):
                live.add(runtime["id"])
        if not live:
            return set(), "managed runtime not reported healthy by worker"
        wanted = {(getattr(m, "runtime", None), getattr(m, "id", None))
                  for m in getattr(config, "models", []) or []
                  if getattr(m, "runtime", None) in configured}
        ready = set()
        for model in report["models"]:
            if not isinstance(model, dict):
                continue
            rid, mid = model.get("runtime"), model.get("id")
            if (_is_str(rid) and _is_str(mid) and rid in live and (rid, mid) in wanted
                    and model.get("available") is True and model.get("simulated") is False):
                ready.add((rid, mid))
        if not ready:
            return set(), "managed model not available in worker report"
        return ready, "managed model available"
    except Exception as exc:  # fail closed
        return set(), f"managed probe error ({type(exc).__name__})"


def attached_ready_models(config, data_dir, timeout=ATTACH_PROBE_TIMEOUT_SEC):
    """Set of (runtime_id, model_id) the running worker reports ready. Never raises."""
    return attach_readiness(config, data_dir, timeout)[0]


def decide_usable(config_path=None, data_dir=None, diagnostics=None):
    """Heartbeat usable-bit policy. False unless real capacity is verified.

    Mock/simulated engines always report usable=false: the worker is
    reachable but explicitly not acceptable for inference. A real engine
    reports true only when a configured non-mock runtime has a usable model:
    managed, GGUF magic on disk plus its executable on PATH; attach, the
    running local worker's authenticated `/v1/node` reports that exact
    configured model resident and its runtime ready (needs `data_dir` or the
    token env var). Anything uncertain — missing config, missing worker
    install, load failure, worker down, malformed report — is false.
    Reachability is reported by the beat itself.

    Never raises. When `diagnostics` is a list, one fixed secret-free reason
    for the decision is appended to it.
    """
    try:
        usable, reason = _decide_usable(config_path, data_dir)
    except Exception as exc:  # fail closed; the sender must keep beating
        usable, reason = False, f"usable policy error ({type(exc).__name__})"
    if isinstance(diagnostics, list):
        diagnostics.append(reason)
    return usable


def _decide_usable(config_path, data_dir):
    if not config_path:
        return False, "no worker config"
    try:
        from dendrite.config import load_config
        from dendrite.hardware import file_identity
    except ImportError:
        return False, "worker package unavailable"
    try:
        config = load_config(Path(config_path))
    except Exception:
        return False, "worker config failed to load"
    runtimes = {r.id: r for r in getattr(config, "runtimes", []) or []}
    if not runtimes or all(getattr(r, "kind", "") == "mock" for r in runtimes.values()):
        return False, "mock/simulated runtime only"
    attached = None  # probed lazily, at most once per decision
    managed, managed_reason = None, ""
    reason = "no configured real model is ready"
    for model in getattr(config, "models", []) or []:
        runtime = runtimes.get(getattr(model, "runtime", None))
        if runtime is None or getattr(runtime, "kind", "") == "mock":
            continue
        if getattr(runtime, "mode", "") == "attach":
            if attached is None:
                attached, reason = attach_readiness(config, data_dir)
            if (runtime.id, getattr(model, "id", None)) in attached:
                return True, f"attach model ready: {runtime.id}/{model.id}"
            continue
        path = getattr(model, "path", None)
        executable = getattr(runtime, "executable", None)
        try:
            cached = bool(path and file_identity(path)["cached_on_disk"])
        except Exception:
            cached = False
        if cached and executable and shutil.which(str(executable)):
            # Files alone are not capacity: the worker that would run the
            # engine must be up and agree the model is available.
            if managed is None:
                managed, managed_reason = managed_readiness(config, data_dir)
            if (runtime.id, getattr(model, "id", None)) in managed:
                return True, f"managed model available: {runtime.id}/{model.id}"
            reason = managed_reason
    return False, reason


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # Never forward the bearer or the pairing code, including on a TLS
        # downgrade or a same-origin redirect. Use the configured API directly.
        return None


def edge_block_marker(status, raw, content_type):
    """Sanitized diagnosis for a non-JSON HTTP error body. Never echoes bytes.

    An edge/CDN/proxy refusal (e.g. Cloudflare HTML on 403) carries no API
    payload; reporting only the status left users with a generic
    CLAIM_FAILED. The marker names the status plus a fixed content class
    derived from the Content-Type header and the first non-space byte, and
    hints at the pre-API block. Response bytes are never included.
    """
    claimed = (content_type or "").split(";")[0].strip().lower()
    first = raw.lstrip()[:1]
    if "html" in claimed or first == "<":
        kind = "HTML"
    elif "json" in claimed:
        kind = "unparseable JSON"
    elif "text" in claimed or (first and first.isprintable()):
        kind = "text"
    elif not raw.strip():
        kind = "empty"
    else:
        kind = "binary"
    return {
        "code": "EDGE_BLOCKED",
        "error": (f"API refused with a non-JSON {kind} error page "
                  f"(HTTP {status}); the request was blocked before reaching "
                  f"the API (edge or proxy). Update the worker and retry; "
                  f"no response content is shown."),
    }


def post_json(url, payload, secret=None, timeout=REQUEST_TIMEOUT_SEC):
    """POST JSON, returning (status, body-dict, retry-after)."""
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if secret is not None:
        headers["Authorization"] = "Bearer " + secret
    request = Request(url, data=data, headers=headers, method="POST")
    try:
        with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode("utf-8", "replace")
            retry_after = response.headers.get("Retry-After")
            content_type = response.headers.get("Content-Type")
    except HTTPError as exc:
        try:
            if 300 <= exc.code < 400:
                raise PairingError(None, "REDIRECT_BLOCKED", "API redirects are refused")
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            content_type = exc.headers.get("Content-Type") if exc.headers else None
        except (http.client.HTTPException, OSError) as fault:
            raise PairingError(None, "NETWORK", "incomplete API response") from fault
        finally:
            exc.close()
    except (URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException) as exc:
        # A truncated response belongs to the same bounded transport backoff.
        raise PairingError(None, "NETWORK", "API transport failed") from exc
    parsed = True
    try:
        body = json.loads(raw) if raw.strip() else {}
    except ValueError:
        body = {}
        parsed = False
    if not isinstance(body, dict):
        body = {}
        parsed = False
    if not parsed and status >= 400:
        # Error statuses without an API payload are edge/proxy refusals, not
        # API verdicts: surface the sanitized marker instead of a bare {} that
        # callers would render as a generic CLAIM_FAILED/HEARTBEAT_FAILED.
        body = edge_block_marker(status, raw, content_type)
    retry_sec = None
    for candidate in (body.get("retryAfterSec"), retry_after):
        try:
            retry_sec = max(1, int(candidate))
            break
        except (TypeError, ValueError):
            continue
    return status, body, retry_sec


def claim(api_base, code, node_id, hardware):
    """Exchange a one-time code for {resource_id, heartbeat key, ...}."""
    base = check_api_base(api_base)
    payload = {"code": code, "nodeId": node_id}
    for key in ("name", "kind", "cpu", "gpu", "capabilities"):
        if hardware.get(key) not in (None, "", []):
            payload[key] = hardware[key]
    status, body, retry_after = post_json(base + "/api/pairing/claim", payload)
    err = body.get("code") or "CLAIM_FAILED"
    msg = body.get("error") or f"claim failed (HTTP {status})"
    if status in (200, 201):
        if not body.get("resourceId") or not body.get("heartbeatKey"):
            raise PairingError(status, "BAD_CLAIM_RESPONSE", "claim response lacks resource or key")
        return body
    if status == 404:
        raise PairingError(status, err, msg)
    if status == 410:
        raise PairingError(status, err, msg)
    if status == 409:
        raise PairingError(status, err, msg)
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def send_heartbeat(api_base, resource_id, secret, usable):
    """Post one reachability beat. Returns the parsed response body."""
    base = check_api_base(api_base)
    status, body, retry_after = post_json(
        f"{base}/api/resources/{resource_id}/heartbeat", {"usable": bool(usable)}, secret)
    err = body.get("code") or "HEARTBEAT_FAILED"
    msg = body.get("error") or f"heartbeat failed (HTTP {status})"
    if status == 200:
        return body
    if status == 401 and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(status, err, msg)
    if status == 401:
        raise PairingError(status, err, msg)
    if status == 404:
        raise PairingError(status, err, "resource missing or key bound elsewhere; re-pair")
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def _memory_bytes():
    """(total, available) RAM bytes via psutil, or None when unmeasurable.

    Imported lazily so this module stays standard-library-only: a
    pairing-only frozen bundle without psutil simply does not report.
    """
    try:
        import psutil
    except ImportError:
        return None
    try:
        memory = psutil.virtual_memory()
        return int(memory.total), int(memory.available)
    except Exception:
        return None


def _disk_bytes(path):
    """(total, free) bytes for the volume holding `path`, or None."""
    try:
        usage = shutil.disk_usage(str(path))
        return int(usage.total), int(usage.free)
    except (OSError, ValueError):
        return None


def _reportable_runtimes(config_path, data_dir=None):
    """Runtimes this node can honestly claim, from its own worker config.

    Conservative by design (never claims what it cannot see): mock runtimes
    are not capacity; an attach runtime counts only when the running local
    worker reports one of its configured models ready (attach_readiness,
    needs `data_dir` or the token env var, never probed otherwise); a
    managed runtime counts only when its engine executable resolves on PATH.
    Unknown kinds and unreadable configs report nothing.
    """
    if not config_path:
        return []
    try:
        from dendrite.config import load_config
        config = load_config(Path(config_path))
    except Exception:
        return []
    found = []
    attached = None  # probed lazily, at most once per report
    attach_pairs = set()
    managed = None  # same for the managed readiness probe
    managed_pairs = set()
    for runtime in getattr(config, "runtimes", []) or []:
        name = CAPABILITY_RUNTIME_NAMES.get(getattr(runtime, "kind", ""))
        if name is None:
            continue
        mode = getattr(runtime, "mode", "")
        if mode == "attach":
            if data_dir is None and not _worker_token(config, None):
                continue
            if attached is None:
                attach_pairs = attach_readiness(config, data_dir)[0]
                attached = {rid for rid, _ in attach_pairs}
            # Dedupe by (name, mode): a mixed config (attach + managed
            # runtimes of one kind) reports both entries; name-only dedupe
            # would silently drop the second transport.
            if runtime.id in attached and all((r["name"], r.get("mode")) != (name, "attach") for r in found):
                entry = {"name": name, "mode": "attach",
                         "formats": list(CAPABILITY_FORMATS)}
                # Worker-origin model IDs (FABRIC067 integration): attach
                # the probed models for qualified runtimes only. The helper
                # returns {} for foreign names and never raises; a missing
                # module keeps the report model-less rather than breaking it.
                try:
                    from model_readiness import runtime_models_entry
                    entry.update(runtime_models_entry(
                        name, sorted({m for r, m in attach_pairs if r == runtime.id})[:32]))
                except Exception:
                    pass
                entry["configured"] = _configured_model_ids(config, runtime.id)
                found.append(entry)
            continue
        if mode != "managed":
            continue
        executable = getattr(runtime, "executable", None)
        if not executable or not shutil.which(str(executable)):
            continue
        if all((r["name"], r.get("mode")) != (name, "managed") for r in found):
            entry = {"name": name, "mode": "managed",
                     "formats": list(CAPABILITY_FORMATS)}
            # Managed readiness models, same shape as attach: the running
            # worker must report the configured model available and not
            # simulated. Unavailable probe keeps the entry model-less.
            if data_dir is not None or _worker_token(config, None):
                if managed is None:
                    managed_pairs = managed_readiness(config, data_dir)[0]
                    managed = {rid for rid, _ in managed_pairs}
                if runtime.id in managed:
                    try:
                        from model_readiness import runtime_models_entry
                        entry.update(runtime_models_entry(
                            name, sorted({m for r, m in managed_pairs if r == runtime.id})[:32]))
                    except Exception:
                        pass
            entry["configured"] = _configured_model_ids(config, runtime.id)
            found.append(entry)
    return found[:16]


def _configured_model_ids(config, runtime_id):
    """Stable configured model ids for one runtime, from config only.

    Unlike readiness, this changes only when the operator edits the config,
    so the qualification digest binds it without churning on unload/reload.
    Bounded, sorted, deduplicated; never raises.
    """
    try:
        ids = []
        for model in getattr(config, "models", []) or []:
            if getattr(model, "runtime", None) != runtime_id:
                continue
            mid = getattr(model, "id", None)
            if isinstance(mid, str) and 1 <= len(mid) <= 256:
                ids.append(mid)
            if len(ids) >= 32:
                break
        return sorted(set(ids))
    except Exception:
        return []


def _bounded_pair(total, avail):
    """Clamp a (total, avail) measurement into the server's accepted shape."""
    total = max(0, min(int(total), MAX_SAFE_INT))
    avail = max(0, min(int(avail), total))
    return total, avail


def build_capability_report(config_path=None, data_dir=None):
    """Build a node capability report, or None when it cannot be measured.

    Shape matches validateCapabilityBody (website/src/worker.js): exactly
    schema_version, os, arch, runtimes, mem, disk. GPU memory is omitted:
    the available probe measures total VRAM only, and the server requires
    avail <= total, so reporting free VRAM would be a guess.
    """
    memory = _memory_bytes()
    disk = _disk_bytes(data_dir if data_dir else Path.home())
    if memory is None or disk is None:
        return None
    ram_total, ram_avail = _bounded_pair(*memory)
    disk_total, disk_avail = _bounded_pair(*disk)
    return {
        "schema_version": CAPABILITY_SCHEMA_VERSION,
        "os": (platform.system() or "unknown")[:64],
        "arch": (platform.machine() or "unknown")[:64],
        "runtimes": _reportable_runtimes(config_path, data_dir),
        "mem": {"ramTotalBytes": ram_total, "ramAvailBytes": ram_avail},
        "disk": {"totalBytes": disk_total, "availBytes": disk_avail},
    }


def send_capabilities(api_base, resource_id, secret, report):
    """Post one capability report under the heartbeat key. Returns the body."""
    base = check_api_base(api_base)
    status, body, retry_after = post_json(
        f"{base}/api/resources/{resource_id}/capabilities", report, secret)
    err = body.get("code") or "CAPABILITIES_FAILED"
    msg = body.get("error") or f"capability report failed (HTTP {status})"
    if status == 200:
        return body
    if status == 401 and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(status, err, msg)
    if status == 404:
        raise PairingError(status, err, "resource missing or key bound elsewhere; re-pair")
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def capability_target_sec():
    """Latest age a new snapshot may reach: window minus one-beat margin."""
    return CAPABILITY_FRESH_WINDOW_SEC - CAPABILITY_STALE_MARGIN_SEC


def interval_supports_freshness(beat_interval):
    """Whether beats are dense enough to keep a snapshot fresh.

    Supported intervals (at most the 240s target) always have a beat
    inside the freshness window. Coarser beats cannot: the sender still
    reports best-effort after each beat, but snapshots read stale
    between beats and the catalog fails closed on them.
    """
    return beat_interval <= CAPABILITY_INTERVAL_SEC


def capability_period(beat_interval):
    """Seconds from a report to the next one, quantized to the beat grid.

    Reports go out on successful beats only, so the next report lands on
    the latest beat inside [.., target]: the largest multiple of the beat
    interval at or under the 240s target. Coarse beats past the target
    cannot stay fresh; report on the next beat anyway (best effort).
    """
    if not interval_supports_freshness(beat_interval):
        return beat_interval
    multiple = max(capability_target_sec() // beat_interval, 1)
    return multiple * beat_interval


def report_capabilities_step(meta, config_path, data_dir, beat_interval):
    """One best-effort report inside the sender. Never raises.

    Returns seconds until the next attempt. Failures are logged without
    secrets and retried later; liveness is the heartbeat's job, so a
    capability fault must never stop or delay the sender.
    """
    report = build_capability_report(config_path, data_dir)
    if report is None:
        print("capabilities: not measurable here (psutil or disk usage unavailable); not reported",
              file=sys.stderr)
        return capability_period(beat_interval)
    try:
        result = send_capabilities(meta["api_base"], meta["resource_id"],
                                   meta["heartbeat_key"], report)
    except PairingError as exc:
        if exc.status == 429:
            wait = max(exc.retry_after or CAPABILITY_RETRY_SEC, HEARTBEAT_MIN_INTERVAL_SEC)
        else:
            wait = CAPABILITY_RETRY_SEC
        print(f"capabilities: [{exc.code}] {exc}; retrying in {wait}s", file=sys.stderr)
        return wait
    print(f"capabilities ok: runtimes={len(report['runtimes'])} at={result.get('reportedAt')}")
    return capability_period(beat_interval)


def pairing_files(data_dir):
    data = Path(data_dir)
    return {
        "meta": data / "pairing.json",
        "key": data / "heartbeat-key.txt",
        "status": data / "state" / "heartbeat-status.json",
    }


def pairing_key_path(data_dir, meta):
    generation = meta.get("key_file")
    if generation is None:
        return pairing_files(data_dir)["key"]  # read-only legacy compatibility
    if not isinstance(generation, str) or not re.fullmatch(r"heartbeat-key\.[a-f0-9]{32}\.txt", generation):
        raise PairingError(None, "BAD_PAIRING_STORE", "invalid pairing key generation; pair again")
    return Path(data_dir) / generation


def managed_key_files(data_dir):
    data = Path(data_dir)
    legacy = data / "heartbeat-key.txt"
    found = [legacy] if legacy.exists() else []
    # os.scandir (unlike Path.glob) propagates directory access errors, so an
    # unreadable store fails loudly instead of silently keeping live keys.
    # Names are filtered exactly before any deletion is attempted.
    with os.scandir(data) as entries:
        for entry in entries:
            if re.fullmatch(r"heartbeat-key\.[a-f0-9]{32}\.txt", entry.name):
                found.append(data / entry.name)
    return found


def load_pairing(data_dir):
    """Load pairing metadata + secret. Raises PairingError when unpaired."""
    check_private_store(data_dir)
    files = pairing_files(data_dir)
    if not files["meta"].exists():
        raise PairingError(None, "NOT_PAIRED", "worker is not paired; run `pair` first")
    try:
        meta = json.loads(files["meta"].read_text(encoding="utf-8"))
        if not isinstance(meta, dict):
            raise ValueError("invalid metadata")
        # Select the key from this one manifest snapshot, never a second read.
        key_file = pairing_key_path(data_dir, meta)
        check_private_store(data_dir, key_file)
        secret = key_file.read_text(encoding="utf-8").strip()
    except (OSError, ValueError) as exc:
        raise PairingError(None, "BAD_PAIRING_STORE", f"pairing store unreadable: {exc}")
    if not meta.get("resource_id") or not meta.get("api_base") or not secret:
        raise PairingError(None, "BAD_PAIRING_STORE", "pairing store is incomplete; pair again")
    fingerprint = meta.get("key_sha256")
    if fingerprint is not None and (not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or not hmac.compare_digest(fingerprint, hashlib.sha256(secret.encode("utf-8")).hexdigest())):
        raise PairingError(None, "BAD_PAIRING_STORE", "credential files disagree; pair again")
    meta["heartbeat_key"] = secret
    return meta


def pairing_status_binding(meta):
    # Bind legacy flat keys as well as immutable generations. No bearer is
    # persisted in status; its digest also detects a same-resource key rotation.
    selected = {"api_base": meta["api_base"], "resource_id": meta["resource_id"],
                "key_file": meta.get("key_file"),
                "key_sha256": hashlib.sha256(meta["heartbeat_key"].encode("utf-8")).hexdigest()}
    return hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def write_status(data_dir, payload, meta=None):
    # Heartbeat callers supply the snapshot they actually sent with. Reading
    # the latest manifest here would mislabel an old in-flight response after
    # re-pairing. Two-argument callers bind their current private snapshot.
    selected = load_pairing(data_dir) if meta is None else meta
    files = pairing_files(data_dir)
    record = {**payload, "pairing_generation": pairing_status_binding(selected)}
    write_private(files["status"], json.dumps(record, indent=2) + "\n")


class _SenderLock:
    """Held-open handle on data-dir `sender.lock` for one heartbeat loop.

    The OS releases the handle at process death (including kill -9 /
    Taskkill / crash), so a dead sender never wedges the next start.
    Visibility settles within about a second: a probe immediately after
    a kill may still see the dying holder. The
    file is a marker only: it carries no PID, no credential, and no path,
    and readers must never infer liveness from its mere existence.
    """

    def __init__(self, handle, path):
        self.handle = handle
        self.path = path

    def release(self):
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass


def _hold_sender_lock(data_dir):
    """Open (creating) `sender.lock` and take it non-blocking, or None.

    Windows: the open always succeeds and msvcrt.locking on byte 0
    decides, so a stale file from a dead sender is reusable. POSIX: the
    open always succeeds and LOCK_EX|LOCK_NB on the descriptor decides.
    Either way only a live conflicting holder refuses us.
    """
    path = Path(data_dir) / "sender.lock"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    if os.name == "nt":
        try:
            # Function-level: msvcrt exists on Windows only, and this
            # module imports on every platform.
            import msvcrt
            handle = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
        except (OSError, ImportError):
            return None
        try:
            msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
        except (OSError, ImportError):
            os.close(handle)
            return None
        try:
            stream = os.fdopen(handle, "r")
        except OSError:
            os.close(handle)
            return None
        return _SenderLock(stream, path)
    try:
        # Function-level: fcntl exists on POSIX only, and this module
        # imports on every platform.
        import fcntl
        handle = open(path, "a+b")
    except (OSError, ImportError):
        return None
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        handle.close()
        return None
    return _SenderLock(handle, path)


def sender_lock_held(data_dir):
    """True when another live process currently holds `sender.lock`.

    Never raises on lock mechanics: any uncertainty answers False and the
    caller spawns; the child then reports exit 6 itself, which is the same
    outcome with one extra short-lived process. Never True from a stale
    file: only a live conflicting holder counts.
    """
    path = Path(data_dir) / "sender.lock"
    if os.name == "nt":
        try:
            import msvcrt
            probe = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
        except (OSError, ImportError):
            return False
        try:
            msvcrt.locking(probe, msvcrt.LK_NBLCK, 1)
        except (OSError, ImportError):
            os.close(probe)
            return True
        try:
            msvcrt.locking(probe, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        os.close(probe)
        return False
    try:
        import fcntl
        probe = open(path, "a+b")
    except (OSError, ImportError):
        return False
    try:
        fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        probe.close()
        return True
    try:
        fcntl.flock(probe.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    probe.close()
    return False

@contextlib.contextmanager
def pair_lock(data_dir):
    """Per-data-directory pair mutex (Muse W3 rounds 11/13).

    Serializes the claim plus the generation and manifest writes so
    concurrent pairs cannot install an already-revoked credential:
    without it, a slow responder's manifest overwrites the winner's
    with its dead key. The lock is OS-held (an msvcrt byte-range lock
    on Windows, a flock elsewhere) on an open descriptor, never
    existence-based: a dead holder's lock is released by the OS on
    process death, so there is no stale-lock deletion path and no
    deletion race. Acquisition waits up to PAIR_LOCK_TIMEOUT_SEC and
    then fails cleanly with PAIR_IN_PROGRESS, never by deleting.
    """
    # The mutex may be the first thing to touch the data directory (unpair or
    # heartbeat before any pair). Provision it privately, not with a bare
    # mkdir that would leave an inherited ACL or the token's default owner
    # that no later creator ever repairs.
    private_dir(data_dir)
    lock = Path(data_dir) / "pair.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + PAIR_LOCK_TIMEOUT_SEC
        while True:
            try:
                _fd_lock_exclusive(fd)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise PairingError(None, "PAIR_IN_PROGRESS",
                                       f"another pair is using {data_dir}; "
                                       "wait for it to finish and retry")
                time.sleep(0.05)
        try:
            yield
        finally:
            _fd_unlock(fd)
    finally:
        os.close(fd)


def _fd_lock_exclusive(fd):
    """Take a non-blocking exclusive lock on fd. Raises OSError when held."""
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)  # msvcrt locks from the file position
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _fd_unlock(fd):
    """Release the lock taken by _fd_lock_exclusive. Never raises."""
    try:
        if os.name == "nt":
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


@contextlib.contextmanager
def sender_lock(data_dir):
    """Cross-process sender exclusion (macOS/POSIX lane, 2026-11-01).

    Held for a heartbeat-loop so a restarted controller cannot start a
    second sender while an orphaned first sender still beats. OS-held
    like pair_lock (flock/msvcrt, never existence-based): a dead
    holder's lock is released by the OS. Fails fast with SENDER_RUNNING.
    """
    private_dir(data_dir)
    lock = Path(data_dir) / "sender.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            _fd_lock_exclusive(fd)
        except OSError as exc:
            raise PairingError(None, "SENDER_RUNNING",
                               f"another heartbeat sender is using {data_dir}") from exc
        try:
            yield
        finally:
            _fd_unlock(fd)
    finally:
        os.close(fd)


def cmd_pair(args):
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
        private_dir(data_dir)
        # Retained keys may still authenticate to a previous API origin or be
        # held by an older reader. Keep them, but establish privacy before a
        # claim or success message, not just for the newly published generation.
        for key_file in managed_key_files(data_dir):
            if not restrict_file(key_file):
                raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        if (data_dir / "pairing.json").exists() and not restrict_file(data_dir / "pairing.json"):
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        node_id = load_or_create_node_id(data_dir / "state")
        hardware = probe_hardware(args.config)
        if args.name:
            hardware["name"] = args.name[:80]
        code = args.code or getpass.getpass("Pairing code from the AIPSTER dashboard: ").strip()
        if not code:
            print("pairing: no code entered", file=sys.stderr)
            return EXIT_USAGE
        # The claim plus both writes hold the pair mutex (Muse W3 round
        # 11): without it a slow responder's manifest overwrites the
        # winner's with an already-revoked key. The mutex spans the claim
        # plus both credential writes only -- never the human prompt above
        # and never the success prints below.
        with pair_lock(data_dir):
            result = claim(args.api_base, code, node_id, hardware)
            files = pairing_files(data_dir)
            generation = "heartbeat-key." + secrets.token_hex(16) + ".txt"
            secret = result["heartbeatKey"].strip()
            meta = {
                "api_base": check_api_base(args.api_base),
                "resource_id": result["resourceId"],
                "node_id": node_id,
                "key_id": result.get("keyId"),
                "key_prefix": result.get("keyPrefix"),
                "heartbeat_url": result.get("heartbeatUrl"),
                "created": result.get("created"),
                "claimed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "key_file": generation,
                "key_sha256": hashlib.sha256(secret.encode("utf-8")).hexdigest(),
            }
            key_file = data_dir / generation
            # The manifest is the commit point. A failed/interrupted write leaves
            # either the old tuple or the complete new tuple, never mixed origins.
            # Retain old/unpublished private generations until unpair: an in-flight
            # reader may still hold an older manifest snapshot.
            write_private(key_file, secret + "\n")
            write_private(files["meta"], json.dumps(meta, indent=2) + "\n")
    except PairingError as exc:
        print(f"pairing failed [{exc.code}]: {exc}", file=sys.stderr)
        if exc.code == "NETWORK":
            return EXIT_NETWORK
        if exc.status is None:
            return EXIT_USAGE
        return EXIT_PAIRING_REJECTED
    except OSError:
        print("pairing failed [PRIVATE_STORAGE]: worker state could not be committed; pair again", file=sys.stderr)
        return EXIT_USAGE
    print(f"paired: resource {meta['resource_id']} (key {meta['key_prefix']})")
    print(f"stored: {files['meta']} + {key_file} (user-only access)")
    print("heartbeat proves reachability only; it never means inference-ready")
    return EXIT_OK


def cmd_heartbeat(args, loop):
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
        # Atomic with pair's writes (Muse W3 round 13): an unlocked
        # initial read racing pair's generation-then-manifest writes can
        # observe a deleted generation and mis-exit BAD_PAIRING_STORE,
        # leaving the sender stopped after a successful pair. The lock is
        # held for the read only, never across the loop.
        with pair_lock(data_dir):
            meta = load_pairing(data_dir)
    except PairingError as exc:
        print(f"heartbeat: [{exc.code}] {exc}", file=sys.stderr)
        return EXIT_USAGE if exc.status is None else EXIT_NETWORK
    interval = max(args.interval, HEARTBEAT_MIN_INTERVAL_SEC)
    sender_guard = None
    if loop:
        # One sender per data dir: a second loop exits SENDER_RUNNING
        # instead of doubling heartbeats. The try/finally below releases
        # promptly at return, and the OS drops the handle at process
        # death, so a crash never wedges the next start. --once never
        # takes the lock.
        sender_guard = _hold_sender_lock(data_dir)
        if sender_guard is None:
            print("heartbeat: [SENDER_RUNNING] another sender is already "
                  "running for this data dir; not starting a second",
                  file=sys.stderr)
            return EXIT_SENDER_RUNNING
    failures = 0
    first_beat = True
    next_capability_at = 0.0  # monotonic; opt-in reports go out after a successful beat
    if loop and getattr(args, "report_capabilities", False) and not interval_supports_freshness(interval):
        print(f"capabilities: heartbeat interval {interval}s is coarser than the "
              f"{CAPABILITY_INTERVAL_SEC}s report target; snapshots will read stale between beats "
              "(the catalog fails closed on them)", file=sys.stderr)
    if loop and hasattr(sys.stdout, "reconfigure"):
        # Supervised senders pipe stdout to the tray log: line-buffer so
        # each beat lands promptly instead of sitting in the block buffer.
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except (OSError, ValueError):
            pass
    try:
        while True:
            if not first_beat:
                # Reload every beat: unpair stops the sender instead of beating on
                # a cached credential, and a re-pair switches it to the new key.
                # Under the mutex (Muse W3 round 11): the reload must not
                # race a concurrent pair's writes. A contested lock just
                # delays one beat; it never stops the sender.
                try:
                    with pair_lock(data_dir):
                        meta = load_pairing(data_dir)
                except PairingError as exc:
                    if exc.code == "PAIR_IN_PROGRESS":
                        print("heartbeat: pair in progress; rechecking after the interval",
                              file=sys.stderr)
                        time.sleep(interval)
                        continue
                    if exc.code != "NOT_PAIRED":
                        print(f"heartbeat: [{exc.code}] {exc}", file=sys.stderr)
                        return EXIT_USAGE
                    write_status(data_dir, {"at": time.time(), "ok": False, "status": "unpaired",
                                            "code": exc.code}, meta)
                    print("heartbeat: worker was unpaired; sender stopping", file=sys.stderr)
                    return EXIT_REPAIR_REQUIRED
            first_beat = False
            # Recomputed per beat (Codex P2): installed/removed models and
            # engines change readiness, and a stale true would misreport ready.
            usable_why = []
            usable = decide_usable(args.config, data_dir, usable_why)
            try:
                result = send_heartbeat(meta["api_base"], meta["resource_id"],
                                        meta["heartbeat_key"], usable)
            except RePairRequired as exc:
                # A re-pair can land between the reload and the beat: the old key
                # is revoked but a newer credential is already installed. The
                # sender loop retries with it instead of reporting the fresh
                # pairing as dead; a one-shot beat reports and exits.
                # Under the mutex (Muse W3 round 12): compare against a
                # store snapshot no concurrent pair is mid-write on.
                try:
                    with pair_lock(data_dir):
                        latest = load_pairing(data_dir)
                except PairingError:
                    latest = None
                if loop and latest is not None and latest["heartbeat_key"] != meta["heartbeat_key"]:
                    meta = latest
                    first_beat = True
                    continue
                write_status(data_dir, {"at": time.time(), "ok": False,
                                        "status": "repair-required", "code": exc.code}, meta)
                print(f"heartbeat: [{exc.code}] sender key is dead; pair again with a new code",
                      file=sys.stderr)
                return EXIT_REPAIR_REQUIRED
            except PairingError as exc:
                state = "rate-limited" if exc.status == 429 else "network-error" if exc.status is None else "failed"
                write_status(data_dir, {"at": time.time(), "ok": False, "status": state,
                                        "code": exc.code, "retryAfterSec": exc.retry_after}, meta)
                if exc.status == 429:
                    wait = exc.retry_after or interval
                    print(f"heartbeat: rate limited; retrying in {wait}s", file=sys.stderr)
                    if not loop:
                        return EXIT_NETWORK
                    time.sleep(wait)
                    continue
                if exc.status is None or (isinstance(exc.status, int) and exc.status >= 500):
                    # Transport faults AND transient server failures share the
                    # bounded backoff (Codex P2): a 5xx must not terminate the
                    # sender while the service recovers.
                    failures += 1
                    if failures > MAX_ATTEMPTS_NETWORK:
                        print(f"heartbeat: giving up after {MAX_ATTEMPTS_NETWORK} tries: [{exc.code}] {exc}",
                              file=sys.stderr)
                        return EXIT_NETWORK
                    wait = min(2 ** failures, 60)
                    print(f"heartbeat: [{exc.code}] {exc}; retry {failures}/{MAX_ATTEMPTS_NETWORK} in {wait}s",
                          file=sys.stderr)
                    if not loop:
                        return EXIT_NETWORK
                    time.sleep(wait)
                    continue
                print(f"heartbeat failed [{exc.code}]: {exc}", file=sys.stderr)
                return EXIT_PAIRING_REJECTED
            failures = 0
            write_status(data_dir, {"at": time.time(), "ok": True, "usable": usable,
                                    "heartbeatAt": result.get("heartbeatAt"),
                                    "usable_reason": (usable_why or ["unknown"])[0],
                                    "note": "reachability only; not inference-ready"}, meta)
            print(f"heartbeat ok: usable={usable} at={result.get('heartbeatAt')} "
                  f"({(usable_why or ['unknown'])[0]})")
            # After the beat, never before: the report moves heartbeat_at
            # server-side, and the next beat is >= HEARTBEAT_MIN_INTERVAL_SEC
            # away, clear of the 25s window.
            if getattr(args, "report_capabilities", False) and time.monotonic() >= next_capability_at:
                next_capability_at = time.monotonic() + report_capabilities_step(
                    meta, args.config, data_dir, interval)
            if not loop:
                return EXIT_OK
            time.sleep(interval)
    finally:
        # Explicit release: a traceback cycle through a
        # mocked beat can outlive this frame past temp-dir
        # cleanup, so prompt GC timing must not matter.
        if sender_guard is not None:
            sender_guard.release()


def cmd_capabilities(args):
    """Build, and unless --dry-run post, one capability report."""
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    except PairingError as exc:
        print(f"capabilities: [{exc.code}] {exc}", file=sys.stderr)
        return EXIT_USAGE
    if args.dry_run:
        # Local preview only: no pairing state read, no network, no secrets.
        report = build_capability_report(args.config, data_dir if data_dir.exists() else None)
        if report is None:
            print("capabilities: not measurable here (psutil or disk usage unavailable)", file=sys.stderr)
            return EXIT_USAGE
        print(json.dumps(report, indent=2))
        return EXIT_OK
    try:
        with pair_lock(data_dir):
            meta = load_pairing(data_dir)
    except PairingError as exc:
        print(f"capabilities: [{exc.code}] {exc}", file=sys.stderr)
        return EXIT_USAGE if exc.status is None else EXIT_NETWORK
    report = build_capability_report(args.config, data_dir)
    if report is None:
        print("capabilities: not measurable here (psutil or disk usage unavailable)", file=sys.stderr)
        return EXIT_USAGE
    try:
        result = send_capabilities(meta["api_base"], meta["resource_id"],
                                   meta["heartbeat_key"], report)
    except RePairRequired as exc:
        print(f"capabilities: [{exc.code}] sender key is dead; pair again with a new code",
              file=sys.stderr)
        return EXIT_REPAIR_REQUIRED
    except PairingError as exc:
        print(f"capabilities failed [{exc.code}]: {exc}", file=sys.stderr)
        if exc.status is None or exc.status == 429 or exc.status >= 500:
            return EXIT_NETWORK
        return EXIT_PAIRING_REJECTED
    print(f"capabilities ok: runtimes={len(report['runtimes'])} at={result.get('reportedAt')}")
    return EXIT_OK


def cmd_status(args):
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    files = pairing_files(data_dir)
    if not files["meta"].exists():
        print("status: not paired")
        return EXIT_OK
    try:
        meta = load_pairing(data_dir)
    except (PairingError, OSError, ValueError):
        print("status: pairing store unreadable; pair again")
        return EXIT_USAGE
    print(f"status: paired resource={meta.get('resource_id')} key={meta.get('key_prefix')}")
    if files["status"].exists():
        try:
            st = json.loads(files["status"].read_text(encoding="utf-8"))
            if not isinstance(st, dict) or st.get("pairing_generation") != pairing_status_binding(meta):
                print("status: awaiting heartbeat for current pairing")
                return EXIT_OK
            if st.get("ok") is True and time.time() - float(st.get("at", 0)) > STATUS_STALE_SEC:
                print(f"status: stale; last successful beat at={st.get('heartbeatAt')}")
            elif st.get("ok") is not True:
                print(f"status: {st.get('status', 'failed')} code={st.get('code')}")
            else:
                print(f"status: last beat ok=True at={st.get('heartbeatAt')}")
        except (OSError, ValueError, TypeError):
            pass
    return EXIT_OK


def cmd_unpair(args):
    # Local forget only: the server-side sender key stays live until revoked
    # in the dashboard Keys panel, and the resource row is untouched.
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    files = pairing_files(data_dir)
    removed, failed = [], 0
    # Under the same mutex as pair (Muse W3 round 12): an unlocked
    # deletion racing pair's writes could remove the new generation
    # before the new manifest lands, leaving a success-reported
    # NOT_PAIRED store. The scandir-based deletion below is unchanged.
    try:
        with pair_lock(data_dir):
            try:
                paths = [files["meta"], *managed_key_files(data_dir)]
            except FileNotFoundError:
                paths = [files["meta"]]
            except OSError:
                paths, failed = [], 1
            for path in paths:
                try:
                    path.unlink()
                    removed.append(str(path))
                except FileNotFoundError:
                    pass
                except OSError:
                    failed += 1
    except PairingError as exc:
        print(f"unpair failed [{exc.code}]: {exc}", file=sys.stderr)
        return EXIT_USAGE
    if failed:
        print("unpair failed [PRIVATE_STORAGE]: some pairing files could not be removed; stop the sender and retry", file=sys.stderr)
        if removed:
            print(f"removed {len(removed)} local pairing file(s); cleanup is incomplete", file=sys.stderr)
        print("note: revoke the sender key in the dashboard Keys panel; it stays live until then", file=sys.stderr)
        return EXIT_USAGE
    if removed:
        print("unpaired locally: " + ", ".join(removed))
        print("note: revoke the sender key in the dashboard Keys panel; it stays live until then")
    else:
        print("status: not paired")
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(description="AIPSTER worker pairing + heartbeat sender")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE,
                        help="AIPSTER API base (https, or http loopback for tests)")
    parser.add_argument("--data-dir", default=None,
                        help="worker data dir (default: installed location)")
    sub = parser.add_subparsers(dest="command", required=True)
    pair = sub.add_parser("pair", help="exchange a dashboard code for a sender key")
    pair.add_argument("--code", default=None, help="one-time code (else prompted, not echoed)")
    pair.add_argument("--config", default=None, help="worker config for hardware discovery")
    pair.add_argument("--name", default=None, help="display-name hint (default: hostname)")
    beat = sub.add_parser("heartbeat-once", help="post a single heartbeat")
    beat.add_argument("--config", default=None, help="worker config for the usable-bit policy")
    beat.add_argument("--interval", type=int, default=HEARTBEAT_INTERVAL_SEC)
    beat.add_argument("--report-capabilities", action="store_true",
                      help="also post one node capability report after the beat (opt-in)")
    loop = sub.add_parser("heartbeat-loop", help="post heartbeats until stopped (one sender per data dir; a second loop exits SENDER_RUNNING)")
    loop.add_argument("--config", default=None, help="worker config for the usable-bit policy")
    loop.add_argument("--interval", type=int, default=HEARTBEAT_INTERVAL_SEC)
    loop.add_argument("--report-capabilities", action="store_true",
                      help="also post node capability reports (opt-in; beat-quantized ~240s cadence, "
                           "stays fresh while --interval is at most 240s)")
    caps = sub.add_parser("capabilities-once",
                          help="post one node capability report (RAM, disk, real runtimes)")
    caps.add_argument("--config", default=None, help="worker config for runtime discovery")
    caps.add_argument("--dry-run", action="store_true",
                      help="print the report without sending it (no pairing or network needed)")
    sub.add_parser("status", help="show pairing state (never secrets)")
    sub.add_parser("unpair", help="forget local pairing (server key untouched)")
    # Inference job runner (lane L3). Kept in its own module so every other
    # command keeps working with the frozen pairing-only bundle; the import
    # happens only when this command is used.
    jobs = sub.add_parser("serve-jobs",
                          help="run leased inference jobs on the local upstream (dark by default)")
    jobs.add_argument("--interval", type=float, default=2.0,
                      help="base idle poll interval in seconds")
    jobs.add_argument("--ganglion-base", "--upstream-url", dest="ganglion_base",
                      default=None,
                      help="local upstream base URL, Ganglion or llama-server "
                           "(default http://127.0.0.1:8471); --upstream-url is an alias")
    jobs.add_argument("--allow-non-loopback-ganglion", action="store_true",
                      help="permit a non-loopback upstream base (not qualified)")
    jobs.add_argument("--runtime-id", default="ganglion",
                      help="runtime identity this worker claims: ganglion or "
                           "llama-server (default ganglion)")
    jobs.add_argument("--models-cache-ttl", type=float, default=30.0,
                      help="seconds to cache the upstream model list")
    jobs.add_argument("--once", action="store_true",
                      help="poll for one job and exit")
    # Qualification benchmark runner (meta-qual lane). Same lazy pattern:
    # the import happens only when this command is used, so every other
    # command keeps working with the frozen pairing-only bundle.
    qual = sub.add_parser("serve-qualification",
                          help="poll benchmark assignments and run the fixed CPU smoke (dark by default)")
    qual.add_argument("--model-id", required=True,
                      help="already-configured ready CPU model to benchmark")
    qual.add_argument("--runtime-id", default="ganglion",
                      help="runtime identity this worker claims: ganglion or "
                           "llama-server (default ganglion)")
    qual.add_argument("--ganglion-base", "--upstream-url", dest="ganglion_base",
                      default=None,
                      help="local upstream base URL, Ganglion or llama-server "
                           "(default http://127.0.0.1:8471); --upstream-url is an alias")
    qual.add_argument("--allow-non-loopback-ganglion", action="store_true",
                      help="permit a non-loopback upstream base (not qualified)")
    qual.add_argument("--config", default=None,
                      help="worker config file used to verify the local CPU "
                           "runtime/model binding before every run "
                           "(required: without it all runs report unsupported)")
    qual.add_argument("--interval", type=float, default=5.0,
                      help="base idle poll interval in seconds")
    qual.add_argument("--once", action="store_true",
                      help="poll for one assignment and exit")
    return parser


def main(argv=None):
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    try:
        if args.command == "pair":
            return cmd_pair(args)
        if args.command == "heartbeat-once":
            return cmd_heartbeat(args, loop=False)
        if args.command == "heartbeat-loop":
            return cmd_heartbeat(args, loop=True)
        if args.command == "capabilities-once":
            return cmd_capabilities(args)
        if args.command == "status":
            return cmd_status(args)
        if args.command == "unpair":
            return cmd_unpair(args)
        if args.command == "serve-jobs":
            # Lazy: the job runner is a separate, opt-in module. Importing it
            # here keeps a pair/heartbeat-only frozen bundle self-contained.
            import inference_worker
            return inference_worker.cmd_serve_jobs(args)
        if args.command == "serve-qualification":
            # Lazy, same as serve-jobs: the benchmark runner is opt-in only.
            import qual_runner
            return qual_runner.cmd_serve_qualification(args)
    except KeyboardInterrupt:
        # Ctrl+C stops the sender cleanly: no traceback, no partial claim
        # (pair's manifest commit is atomic under the pair mutex).
        print("interrupted", file=sys.stderr)
        return 130
    parser.print_help()
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())
