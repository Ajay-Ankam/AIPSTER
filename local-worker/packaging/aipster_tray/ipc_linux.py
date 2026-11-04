"""Linux single-instance + control IPC for the tray controller.

One tray instance per data directory: an exclusive fcntl lock file
(``tray.lock``) proves ownership, and a filesystem Unix-domain socket
(``tray.sock``) in the same user-private data directory carries control
commands. Both live under the data dir (0700), so no other user can
spoof commands and no network port is involved.

Second launches and the ``tray`` CLI connect to the socket and send one
line (``ensure`` | ``stop`` | ``start`` | ``restart`` | ``quit``); the
server replies ``ok`` and the controller applies the matching action.
A stale socket whose lock is free is unlinked by the next owner.
"""

import errno
import fcntl
import hashlib
import os
import socket
from pathlib import Path

COMMANDS = ("ensure", "stop", "start", "restart", "quit")

SOCKET_NAME = "tray.sock"
LOCK_NAME = "tray.lock"


def instance_tag(data_dir):
    digest = hashlib.sha1(str(Path(data_dir).resolve()).encode("utf-8")).hexdigest()
    return digest[:8]


def socket_path(data_dir):
    return Path(data_dir) / SOCKET_NAME


def lock_path(data_dir):
    return Path(data_dir) / LOCK_NAME


class SingleInstance:
    """fcntl lock guard. held is True when this process owns the instance."""

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.handle = None
        self.held = False

    def acquire(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.handle = open(lock_path(self.data_dir), "a+b")
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                self.handle.close()
                self.handle = None
                return False
            raise
        self.held = True
        return True

    def release(self):
        if self.handle is not None:
            try:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                self.handle.close()
            except OSError:
                pass
            self.handle = None
        self.held = False


class CommandServer:
    """Non-blocking command socket owned by the tray instance.

    Poll from the controller tick: pending connections are accepted one
    line at a time and dispatched to ``handler(command)``. Every accepted
    connection gets an ``ok`` (or ``bad``) reply; handler errors are
    reported to ``log`` and never propagate.
    """

    def __init__(self, data_dir):
        self.path = socket_path(data_dir)
        self.sock = None

    def start(self):
        if self.path.exists():
            try:
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    probe.settimeout(1.0)
                    probe.connect(str(self.path))
                finally:
                    probe.close()
            except OSError:
                # Nobody answers: stale socket from a crashed owner.
                try:
                    self.path.unlink()
                except OSError:
                    pass
            else:
                raise OSError(f"command socket is already served: {self.path}")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(str(self.path))
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        self.sock.listen(5)
        self.sock.setblocking(False)

    def poll(self, handler, log=None):
        if self.sock is None:
            return
        while True:
            try:
                conn, _ = self.sock.accept()
            except (BlockingIOError, InterruptedError):
                return
            except OSError as exc:
                if log is not None:
                    log(f"command socket accept failed: {exc}")
                return
            with conn:
                conn.settimeout(5.0)
                try:
                    data = b""
                    while not data.endswith(b"\n") and len(data) < 256:
                        chunk = conn.recv(256 - len(data))
                        if not chunk:
                            break
                        data += chunk
                    command = data.decode("utf-8", "replace").strip().lower()
                    if command in COMMANDS:
                        try:
                            handler(command)
                        except Exception as exc:  # noqa: BLE001 - IPC must answer
                            if log is not None:
                                log(f"command {command} failed: {exc}")
                        conn.sendall(b"ok\n")
                    else:
                        conn.sendall(b"bad\n")
                except OSError:
                    pass

    def stop(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
        try:
            self.path.unlink()
        except OSError:
            pass


def _lock_busy(data_dir):
    """True when another process holds the instance lock (never blocks).

    Opens read-only without creating: a probe must never plant a lock
    file in a data directory it does not own (only SingleInstance.acquire
    creates, and only for the directory the tray is about to serve).
    """
    try:
        handle = open(lock_path(data_dir), "r+b")
    except FileNotFoundError:
        return False
    except OSError:
        return False
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                return True
            return False
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        handle.close()


def running(data_dir):
    """True when a live tray owns this data dir (lock held + answering)."""
    if not _lock_busy(data_dir):
        return False
    path = socket_path(data_dir)
    if not path.exists():
        return False
    try:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(1.5)
            probe.connect(str(path))
        finally:
            probe.close()
    except OSError:
        return False
    return True


def send_command(data_dir, command, timeout=10.0):
    """Deliver one command. Returns (delivered, reply)."""
    if command not in COMMANDS:
        raise ValueError(f"unknown command: {command}")
    path = socket_path(data_dir)
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.settimeout(timeout)
            client.connect(str(path))
            client.sendall((command + "\n").encode("utf-8"))
            reply = b""
            while not reply.endswith(b"\n") and len(reply) < 64:
                chunk = client.recv(64 - len(reply))
                if not chunk:
                    break
                reply += chunk
            return reply.decode("utf-8", "replace").strip() == "ok", reply.decode(
                "utf-8", "replace").strip()
        finally:
            client.close()
    except OSError:
        return False, ""
