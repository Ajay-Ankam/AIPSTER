"""Linux tray entry: owns worker state, child processes, IPC, and one backend.

Mirrors the Windows controller main (``aipster_tray.controller.main``) with
Linux IPC (fcntl lock + Unix socket, ``ipc_linux``) and Linux backends
(indicator when available, Tk window fallback, headless on request):

- ``aipster-tray run [--headless]`` starts the tray (a second launch reuses
  the running instance and shows its window, then exits 0).
- ``aipster-tray status`` prints worker state (live when the tray runs,
  last-known otherwise).
- ``aipster-tray start|stop|restart|quit`` controls the running tray.

Exit codes: 0 ok (run exits only on Quit; second launch exits 0 after reuse),
2 usage/config/no-instance errors.

Data dir: $AIPSTER_WORKER_DATA or ~/.local/share/aipster-worker (shared with
the standalone pairing CLI, so the overlay and `pairing.py pair` agree).
"""

import os
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if not getattr(sys, "frozen", False):
    _SOURCE_ROOT = str(Path(__file__).resolve().parents[2])
    if _SOURCE_ROOT not in sys.path:
        sys.path.insert(0, _SOURCE_ROOT)

from aipster_tray import ipc_linux as ipc  # noqa: E402
from aipster_tray import state as st  # noqa: E402
from aipster_tray.backend_headless import HeadlessBackend  # noqa: E402
from aipster_tray.backend_linux import (LinuxWindowBackend, try_indicator,  # noqa: E402
                                        send_notification)
from aipster_tray.controller import (HEALTH_TIMEOUT, TICK_SECONDS,  # noqa: E402
                                     SECOND_LAUNCH_WAIT)
from aipster_tray.linux_lifecycle import LinuxController  # noqa: E402
from aipster_tray.firstrun import (build_info, data_dir, explicit_demo_ready,  # noqa: E402
                                   first_run_ready)


def dispatch(controller, command):
    """Apply one IPC command. Returns True (always answers ok)."""
    if command == "ensure":
        backend = controller.backend
        try:
            backend.notify("reuse", controller.state, controller.detail)
        except Exception as exc:  # noqa: BLE001 - IPC must always answer
            controller.log(f"reuse notify failed: {exc}")
        try:
            show = getattr(backend, "show", None)
            if callable(show):
                show()
        except Exception as exc:  # noqa: BLE001 - IPC must always answer
            controller.log(f"reuse show failed: {exc}")
        if controller.state in (st.STOPPED, st.ERROR, st.PORT_BUSY):
            controller.start_worker()
    elif command == "stop":
        controller.stop_worker()
    elif command == "start":
        controller.start_worker()
    elif command == "restart":
        controller.restart_worker()
    elif command == "quit":
        controller.request_quit()
    return True


def run_headless_loop(controller, server):
    while controller.running:
        server.poll(lambda cmd: dispatch(controller, cmd), controller.log)
        try:
            controller.tick()
        except Exception as exc:  # noqa: BLE001 - loop must survive
            controller.log(f"tick failed: {exc}")
        time.sleep(TICK_SECONDS)


def run_window_loop(controller, backend, server):
    root = backend.root
    if root is None:  # display vanished between attach and run
        run_headless_loop(controller, server)
        return

    def step():
        if not controller.running:
            try:
                root.quit()
            except Exception:  # noqa: BLE001 - best effort
                pass
            return
        server.poll(lambda cmd: dispatch(controller, cmd), controller.log)
        try:
            controller.tick()
        except Exception as exc:  # noqa: BLE001 - loop must survive
            controller.log(f"tick failed: {exc}")
        try:
            root.after(int(TICK_SECONDS * 1000), step)
        except Exception:  # noqa: BLE001 - shutting down
            pass

    root.after(int(TICK_SECONDS * 1000), step)
    try:
        root.mainloop()
    except Exception as exc:  # noqa: BLE001 - loop must exit cleanly
        controller.log(f"window loop failed: {exc}")


def run_indicator_loop(controller, server):
    import gi
    gi.require_version("GLib", "2.0")
    from gi.repository import GLib
    loop = GLib.MainLoop()

    def step():
        if not controller.running:
            loop.quit()
            return False
        server.poll(lambda cmd: dispatch(controller, cmd), controller.log)
        try:
            controller.tick()
        except Exception as exc:  # noqa: BLE001 - loop must survive
            controller.log(f"tick failed: {exc}")
        return True

    GLib.timeout_add_seconds(TICK_SECONDS, step)
    try:
        loop.run()
    except Exception as exc:  # noqa: BLE001 - loop must exit cleanly
        controller.log(f"indicator loop failed: {exc}")


def _install_signal_handlers(controller):
    def _stop(signum, _frame):
        controller.log(f"signal {signum}: shutting down")
        controller.running = False
    for name in ("SIGTERM", "SIGINT"):
        try:
            signal.signal(getattr(signal, name), _stop)
        except (OSError, ValueError, AttributeError):
            pass


def main(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    headless = False
    if "--headless" in args:
        headless = True
        args.remove("--headless")
    if os.environ.get("AIPSTER_TRAY_HEADLESS") == "1":
        headless = True
    command = args[0] if args else "run"
    try:
        data = data_dir()
    except SystemExit as exc:
        print(f"aipster-tray: {exc}", file=sys.stderr)
        return 2
    console = sys.stdout is not None

    if command in ("-h", "--help", "help"):
        print("usage: aipster-tray [run] [--headless] | start | stop | restart | quit | status")
        print("  run     start the tray (reuses a running instance for this data dir)")
        print("  status  print worker state (live when the tray runs, last-known otherwise)")
        print(f"Data dir: $AIPSTER_WORKER_DATA or {data}.")
        return 0

    if command == "status":
        payload = st.read_state(data / "state.json")
        if payload is None:
            print("AIPSTER Worker tray has never run here (no state file).")
            return 2
        live = ipc.running(data)
        print(st.describe(payload) + (" (live)" if live else " (tray not running)"))
        return 0
    if command in ("start", "stop", "restart", "quit"):
        if not ipc.running(data):
            print(f"no running tray for {data}", file=sys.stderr)
            return 2
        delivered, _ = ipc.send_command(data, command)
        if not delivered:
            print(f"tray did not answer {command}", file=sys.stderr)
            return 2
        print(f"{command} delivered")
        return 0
    if command != "run":
        print(f"unknown command: {command}", file=sys.stderr)
        return 2

    # run: single instance per data dir, else reuse the existing one.
    guard = ipc.SingleInstance(data)
    if not guard.acquire():
        deadline = time.monotonic() + SECOND_LAUNCH_WAIT
        delivered = False
        while time.monotonic() < deadline:
            if ipc.running(data):
                delivered, _ = ipc.send_command(data, "ensure")
                if delivered:
                    break
            time.sleep(0.5)
        if delivered:
            print("tray already running for this data dir; reused it")
            return 0
        print("another instance holds the lock but is not responding", file=sys.stderr)
        return 2

    server = ipc.CommandServer(data)
    try:
        server.start()
    except OSError as exc:
        print(f"cannot listen for commands: {exc}", file=sys.stderr)
        guard.release()
        return 2

    # LinuxController never spawns beside an externally managed worker
    # (external-worker.json), even while a system service restarts.
    controller = LinuxController(data, None, log_lines=console)
    _install_signal_handlers(controller)
    try:
        try:
            controller.prepare()
        except SystemExit as exc:
            print(f"aipster-tray: {exc}", file=sys.stderr)
            return 2
        if headless:
            controller.backend = HeadlessBackend(controller.log)
        else:
            controller.backend = try_indicator(controller.log) or LinuxWindowBackend(controller.log)
        controller.backend.attach(controller)
        controller.log(f"backend={controller.backend.name} run")
        # The tray owns a running worker: start on launch (a busy port or bad
        # config becomes a visible state, never a silent exit).
        if controller.state == st.STOPPED \
                and (first_run_ready(controller.loaded)
                     or explicit_demo_ready(controller.loaded)):
            controller.start_worker()
        if isinstance(controller.backend, HeadlessBackend):
            run_headless_loop(controller, server)
        elif controller.backend.name == "linux-indicator":
            run_indicator_loop(controller, server)
        else:
            run_window_loop(controller, controller.backend, server)
    finally:
        try:
            controller.shutdown()
        finally:
            server.stop()
            guard.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
