"""Linux tray lifecycle guard: never spawn a duplicate worker or sender beside
an externally managed one (for example a system service), including while
that service restarts and its port is briefly free.

External management is persistent, explicit state, not a timing heuristic:
``<data>/external-worker.json``. The operator may create it, or this app
records it the first time it finds its configured port held by a process
that is not its own child and that answers AIPSTER ``/healthz`` ok (the
controller's bounded, read-only loopback probe). While the record exists,
no path in this app starts the worker or the heartbeat sender: launch,
second launch (ensure), menu Start, IPC start/restart, Connect, or a crash
retry. This module never runs systemctl, never stops, restarts or replaces
any process, and never touches config.toml or pairing files. Deleting the
record lets this app manage the worker again.

A record that is linked, not a regular file, owned by another user,
oversized, unreadable or invalid fails closed (treated as declared), so a
damaged record can never let a duplicate spawn.

Linux only: the shared ``Controller`` (and Windows) is unchanged.
"""
import datetime
import json
import os
import stat
import tempfile
from pathlib import Path

from . import state as st
from . import controller as _ctl
from .controller import Controller

EXTERNAL_FILE = "external-worker.json"
MAX_RECORD_BYTES = 4096
EXTERNAL_DETAIL = ("Managed outside this app: this app will not start a worker or "
                   "heartbeat sender here. To let this app manage the worker, "
                   "delete {path}.")
INVALID_DETAIL = ("External-management record is unreadable or invalid, so this "
                  "app will not start a worker or heartbeat sender. Delete {path} "
                  "to let this app manage the worker.")

for _text in (EXTERNAL_DETAIL, INVALID_DETAIL):
    st.check_honest(_text)
del _text


def external_path(data):
    return Path(data) / EXTERNAL_FILE


def load_external(data):
    """None when absent; a dict when external management is declared.

    ``{"valid": False, "reason": ...}`` for any record that cannot be
    trusted; callers treat it as declared (fail closed).
    """
    path = external_path(data)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError:
        return {"valid": False, "reason": "unreadable or linked"}
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return {"valid": False, "reason": "not a regular file"}
        if hasattr(os, "getuid") and info.st_uid != os.getuid():
            return {"valid": False, "reason": "owned by another user"}
        content = os.read(fd, MAX_RECORD_BYTES + 1)
    except OSError:
        return {"valid": False, "reason": "unreadable"}
    finally:
        os.close(fd)
    if len(content) > MAX_RECORD_BYTES:
        return {"valid": False, "reason": "too large"}
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError):
        return {"valid": False, "reason": "invalid"}
    if not isinstance(value, dict) or value.get("version") != 1:
        return {"valid": False, "reason": "invalid"}
    return {"valid": True, "source": str(value.get("source", "")),
            "origin": str(value.get("origin", ""))}


def record_external(data, host, port):
    """Atomically create a private (0600) record. Never replaces an existing one."""
    directory = Path(data)
    path = external_path(directory)
    if os.path.lexists(path):
        return False
    payload = {"version": 1, "source": "observed",
               "origin": st.http_origin(host, port),
               "observed_at": datetime.datetime.now(datetime.timezone.utc)
               .strftime("%Y-%m-%dT%H:%M:%SZ"),
               "note": "A worker this app did not start answered health checks on "
                       "this port. Delete this file to let the app manage the worker."}
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".external-worker-", dir=str(directory))
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(payload, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # link() refuses to replace: an operator record written meanwhile wins.
        os.link(temporary, path)
        return True
    except OSError:  # includes FileExistsError; caller still refuses
        return False
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


class LinuxController(Controller):
    """Controller whose starts honor the external-management record."""

    external = None  # last loaded record (None, or a dict from load_external)

    def external_record(self):
        self.external = load_external(self.data)
        return self.external

    def _own_child_alive(self):
        child = self.child
        try:
            return bool(child is not None and child.pid() and child.exited() is None)
        except Exception:  # noqa: BLE001 - unknown means "maybe ours": do not record
            return True

    def _refuse(self, record):
        self.restart_at = None
        path = external_path(self.data)
        template = EXTERNAL_DETAIL if record.get("valid") else INVALID_DETAIL
        detail = template.format(path=path)
        busy = False
        if self.loaded is not None:
            busy = _ctl.port_busy(self.loaded.node.host, self.loaded.node.port)
        self.log(f"start refused: worker managed outside this app "
                 f"(record {path}, valid={record.get('valid')}, port_busy={busy})")
        self.set_state(st.PORT_BUSY if busy else st.STOPPED, detail)
        return False

    def start_worker(self, manual=True):
        if self.state in (st.RUNNING, st.STARTING):
            return super().start_worker(manual)
        record = self.external_record()
        if record is not None:
            return self._refuse(record)
        if self._reload():
            return super().start_worker(manual)  # surfaces the config error
        host, port = self.loaded.node.host, self.loaded.node.port
        if _ctl.port_busy(host, port) and not self._own_child_alive() \
                and _ctl._health_ok(host, port):
            created = record_external(self.data, host, port)
            self.log(f"healthy worker not started by this app holds {host}:{port}; "
                     f"external-management record created={created}")
            return self._refuse(self.external_record() or {"valid": False})
        return super().start_worker(manual)

    def start_sender(self):
        if self.external_record() is not None:
            self.log("sender not started: worker is managed outside this app")
            return False
        return super().start_sender()
