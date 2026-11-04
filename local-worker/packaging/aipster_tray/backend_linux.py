"""Linux desktop backend for the tray controller (stdlib + Tk, best-effort GI).

The controller drives worker state; this backend presents it on an Ubuntu
desktop without adding dependencies:

- If Ayatana AppIndicator3 (or Gtk StatusIcon) imports, an indicator icon
  with a popup menu rendered from ``state.menu_model`` is shown.
- Otherwise a Tk status window (stdlib ``tkinter``) shows the same state,
  endpoint, pairing overlay and action buttons. The window is the
  guaranteed fallback: closing it hides it (the worker keeps running) and
  re-running ``aipster-tray`` shows it again.
- Desktop notifications use ``gi.repository.Notify`` when available and
  degrade to a log line otherwise.

Every shell call (xdg-open, terminals, clipboard helpers) is guarded so a
missing desktop tool degrades to a log line and never crashes the
controller. Secrets never pass through here: only host:port text is
copied or displayed.
"""

import os
import shlex
import shutil
import subprocess
from pathlib import Path

from . import state as st
from .backend_base import Backend

TERMINALS = ("x-terminal-emulator", "gnome-terminal", "konsole",
             "xfce4-terminal", "mate-terminal", "xterm")


def xdg_open(target):
    """Open a URL/path with the desktop default. Returns True if launched."""
    opener = shutil.which("xdg-open")
    if not opener:
        return False
    try:
        subprocess.Popen([opener, str(target)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except (OSError, ValueError):
        return False
    return True


def find_terminal():
    """(exe, style) for the pair console, or (None, None)."""
    override = os.environ.get("TERMINAL")
    candidates = ([override] if override else []) + list(TERMINALS)
    for name in candidates:
        if not name:
            continue
        exe = shutil.which(name)
        if exe:
            base = Path(exe).name
            if base == "gnome-terminal":
                return exe, "gnome"
            return exe, "dash-e"
    return None, None


def copy_via_helper(text):
    """Copy text with an external clipboard helper. Returns True on success."""
    payload = str(text).encode("utf-8")
    for helper, args in (("wl-copy", []), ("xclip", ["-selection", "clipboard"]),
                         ("xsel", ["--clipboard", "--input"])):
        exe = shutil.which(helper)
        if not exe:
            continue
        try:
            proc = subprocess.run([exe, *args], input=payload, capture_output=True,
                                  timeout=5)
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0:
            return True
    return False


def send_notification(summary, body):
    """Best-effort desktop notification. Returns True if one was shown."""
    try:
        import gi
        gi.require_version("Notify", "0.7")
        from gi.repository import Notify
    except (ImportError, ValueError, AttributeError):
        return False
    try:
        if not Notify.init("AIPSTER Worker"):
            return False
        note = Notify.Notification.new(str(summary), str(body), None)
        return bool(note.show())
    except Exception:  # noqa: BLE001 - notification must never break us
        return False
    finally:
        try:
            Notify.uninit()
        except Exception:  # noqa: BLE001 - best effort only
            pass


class LinuxBaseBackend(Backend):
    """Shared guarded shell actions for the Linux backends."""

    name = "linux-base"

    def __init__(self, log):
        self.log = log
        self.events = []
        self.controller = None

    def attach(self, controller):
        self.controller = controller
        self.log(f"backend={self.name} attached")

    def detach(self):
        self.controller = None
        self.log(f"backend={self.name} detached")

    def refresh(self, state, detail=""):
        self.log(f"backend={self.name} state={state} detail={detail}")

    def notify(self, event, state="", detail=""):
        self.events.append((event, state, detail))
        try:
            title, body = st.balloon_for(event, state, detail)
        except ValueError:
            title, body = "AIPSTER Worker", f"{event} {detail}".strip()
        shown = send_notification(title, body)
        self.log(f"backend={self.name} notify={event} shown={shown} body={body!r}")

    def open_dashboard(self, url):
        if not xdg_open(url):
            self.log(f"backend={self.name} open_dashboard failed (no xdg-open): {url}")
        return url

    def open_logs(self, path):
        if not xdg_open(path):
            self.log(f"backend={self.name} open_logs failed (no xdg-open): {path}")
        return str(path)

    def open_config(self, path):
        self.events.append(("open_config", str(path)))
        if not xdg_open(path):
            self.log(f"backend={self.name} open_config failed (no xdg-open): {path}")
        return str(path)

    def copy_text(self, text):
        ok = copy_via_helper(text)
        self.events.append(("copy_text", str(text)))
        self.log(f"backend={self.name} copy_text helper ok={ok}")
        return ok

    def run_pair_console(self, exe, args):
        terminal, style = find_terminal()
        display = shlex.join([str(exe), *args])
        if terminal is None:
            self.log("backend=linux no terminal emulator found; "
                     f"run this in a terminal to pair: {display}")
            self.note_to_user(f"No terminal found — run this to pair: {display}")
            return (str(exe), list(args))
        if style == "gnome":
            cmd = [terminal, "--"] + [str(exe), *args]
        else:
            cmd = [terminal, "-e"] + [str(exe), *args]
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                             start_new_session=True)
            self.log(f"backend={self.name} pair_console terminal={terminal}")
        except (OSError, ValueError) as exc:
            self.log(f"backend={self.name} pair_console failed: {exc}; "
                     f"run this in a terminal to pair: {display}")
            self.note_to_user(f"Could not open a terminal — run this to pair: {display}")
        return (str(exe), list(args))

    def note_to_user(self, message):
        """Surface a one-line note in the UI; base backend only logs it."""
        self.log(f"backend={self.name} note: {message}")


class LinuxWindowBackend(LinuxBaseBackend):
    """Tk status window: the guaranteed Linux UI (stdlib tkinter only).

    Renders ``state.menu_model`` as status labels plus one button per
    action, honoring the enabled matrix. Closing the window hides it; the
    worker keeps running and re-running ``aipster-tray`` shows it again.
    With no display (no $DISPLAY/$WAYLAND_DISPLAY) the backend stays
    attached but windowless: control continues through ``aipster-tray``
    CLI commands and ``aipster-worker``.
    """

    name = "linux-window"

    def __init__(self, log):
        super().__init__(log)
        self.root = None
        self.widgets = {}
        self.note_text = ""

    # -- attach ---------------------------------------------------------
    def attach(self, controller):
        self.controller = controller
        try:
            import tkinter as tk
        except ImportError as exc:
            self.log(f"backend=linux-window tkinter unavailable: {exc}; "
                     "continuing windowless (CLI control only)")
            return
        if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
            self.log("backend=linux-window no display found; "
                     "continuing windowless (CLI control only)")
            return
        try:
            self.root = tk.Tk()
        except Exception as exc:  # noqa: BLE001 - no display, wrong $DISPLAY, ...
            self.log(f"backend=linux-window cannot open display: {exc}; "
                     "continuing windowless (CLI control only)")
            self.root = None
            return
        self.root.title("AIPSTER Worker")
        self.root.resizable(True, False)
        try:
            self._build()
        except Exception as exc:  # noqa: BLE001 - window must never break us
            self.log(f"backend=linux-window build failed: {exc}")
            try:
                self.root.destroy()
            except Exception:  # noqa: BLE001 - best effort
                pass
            self.root = None
            return
        self.root.protocol("WM_DELETE_WINDOW", self.hide)
        self.log("backend=linux-window attached")

    def _build(self):
        import tkinter as tk
        root = self.root
        header = tk.Label(root, text="", font=("TkDefaultFont", 12, "bold"),
                          anchor="w", justify="left")
        header.pack(fill="x", padx=12, pady=(12, 2))
        endpoint = tk.Label(root, text="", anchor="w", justify="left")
        endpoint.pack(fill="x", padx=12)
        detail = tk.Label(root, text="", anchor="w", justify="left", wraplength=420)
        detail.pack(fill="x", padx=12)
        pair_line = tk.Label(root, text="", anchor="w", justify="left", wraplength=420)
        pair_line.pack(fill="x", padx=12)
        sender_line = tk.Label(root, text="", anchor="w", justify="left")
        sender_line.pack(fill="x", padx=12)
        note = tk.Label(root, text="", anchor="w", justify="left", wraplength=420,
                        fg="red")
        note.pack(fill="x", padx=12)
        buttons = tk.Frame(root)
        buttons.pack(fill="x", padx=12, pady=12)
        self.widgets = {"header": header, "endpoint": endpoint, "detail": detail,
                        "pair_line": pair_line, "sender_line": sender_line,
                        "note": note, "buttons": buttons, "action_buttons": {}}

    # -- visibility ------------------------------------------------------
    def hide(self):
        if self.root is not None:
            try:
                self.root.withdraw()
            except Exception:  # noqa: BLE001 - best effort
                pass
            self.log("backend=linux-window hidden (worker keeps running; "
                     "re-run aipster-tray to show it)")

    def show(self):
        if self.root is not None:
            try:
                self.root.deiconify()
                self.root.lift()
            except Exception as exc:  # noqa: BLE001 - best effort
                self.log(f"backend=linux-window show failed: {exc}")

    def detach(self):
        if self.root is not None:
            try:
                self.root.destroy()
            except Exception:  # noqa: BLE001 - shutdown must complete
                pass
            self.root = None
        super().detach()

    def note_to_user(self, message):
        self.note_text = str(message)
        super().note_to_user(message)
        self.refresh_current()

    # -- rendering ---------------------------------------------------------
    def refresh_current(self):
        if self.controller is None:
            return
        self.refresh(self.controller.state, self.controller.detail)

    def refresh(self, state, detail=""):
        super().refresh(state, detail)
        if self.root is None or self.controller is None:
            return
        try:
            self._render(state, detail)
        except Exception as exc:  # noqa: BLE001 - backend must never break us
            self.log(f"backend=linux-window render failed: {exc}")

    def _render(self, state, detail):
        import tkinter as tk
        ctl = self.controller
        endpoint = ctl.endpoint_label() if ctl.loaded else ""
        overlay = ctl.pairing or {"key": st.PAIR_UNPAIRED, "line": st.UNPAIRED_LINE,
                                  "sender": "Sender: stopped"}
        self.widgets["header"].config(text=f"AIPSTER Worker — {st.STATE_TEXT[state]}")
        self.widgets["endpoint"].config(text=endpoint)
        shown_detail = detail if state in (st.PORT_BUSY, st.ERROR) else ""
        self.widgets["detail"].config(text=shown_detail)
        self.widgets["pair_line"].config(text=overlay.get("line", ""))
        self.widgets["sender_line"].config(text=overlay.get("sender", ""))
        self.widgets["note"].config(text=self.note_text)
        frame = self.widgets["buttons"]
        for child in frame.winfo_children():
            child.destroy()
        self.widgets["action_buttons"] = {}
        for item in st.menu_model(state, endpoint, detail, overlay):
            if item["kind"] != "action":
                continue
            button = tk.Button(frame, text=item["label"],
                               state="normal" if item["enabled"] else "disabled",
                               command=lambda action=item["id"]: self._click(action))
            button.pack(fill="x", pady=1)
            self.widgets["action_buttons"][item["id"]] = button

    def _click(self, action):
        if self.controller is None:
            return
        try:
            self.controller.menu_action(action)
        except Exception as exc:  # noqa: BLE001 - UI must survive action errors
            self.log(f"backend=linux-window action {action} failed: {exc}")
        self.refresh_current()


def try_indicator(log):
    """Best-effort tray indicator. Returns a Backend or None.

    Prefers Ayatana AppIndicator3, then Gtk StatusIcon. Both need a
    display and GI typelibs that minimal installs may lack; anything
    missing (or any error) returns None and the caller uses the Tk
    window fallback instead.
    """
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        log("backend=linux-indicator no display; using window fallback")
        return None
    try:
        import gi
        try:
            gi.require_version("AyatanaAppIndicator3", "0.1")
            from gi.repository import AyatanaAppIndicator3  # noqa: F401
            flavor = "ayatana"
        except (ImportError, ValueError, AttributeError):
            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk  # noqa: F401
            if not hasattr(Gtk, "StatusIcon"):
                raise ImportError("no Gtk.StatusIcon")
            flavor = "statusicon"
    except (ImportError, ValueError, AttributeError) as exc:
        log(f"backend=linux-indicator unavailable ({exc}); using window fallback")
        return None
    return LinuxIndicatorBackend(log, flavor)


class LinuxIndicatorBackend(LinuxBaseBackend):
    """Tray indicator backend (best effort; Tk window remains the fallback).

    Renders the same ``state.menu_model`` into a popup menu and the same
    notifications; shell behavior (dashboard/logs/config/terminal/clipboard)
    is inherited from LinuxBaseBackend.
    """

    name = "linux-indicator"

    def __init__(self, log, flavor):
        super().__init__(log)
        self.flavor = flavor
        self.indicator = None
        self.loop = None

    def attach(self, controller):
        super().attach(controller)
        try:
            import gi
            if self.flavor == "ayatana":
                gi.require_version("AyatanaAppIndicator3", "0.1")
                from gi.repository import AyatanaAppIndicator3 as AppIndicator
                indicator = AppIndicator.Indicator.new(
                    "aipster-worker", "aipster-worker",
                    AppIndicator.IndicatorCategory.APPLICATION_STATUS)
                indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
                self.indicator = indicator
            else:
                gi.require_version("Gtk", "3.0")
                from gi.repository import Gtk
                status = Gtk.StatusIcon.new_from_icon_name("aipster-worker")
                status.set_tooltip_text("AIPSTER Worker")
                self.indicator = status
            self._rebuild_menu()
        except Exception as exc:  # noqa: BLE001 - fall back, never crash
            self.log(f"backend=linux-indicator attach failed: {exc}")
            self.indicator = None

    def _rebuild_menu(self):
        if self.indicator is None or self.controller is None:
            return
        ctl = self.controller
        endpoint = ctl.endpoint_label() if ctl.loaded else ""
        overlay = ctl.pairing or {"key": st.PAIR_UNPAIRED, "line": st.UNPAIRED_LINE,
                                  "sender": "Sender: stopped"}
        try:
            import gi
            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk
            menu = Gtk.Menu()
            for item in st.menu_model(ctl.state, endpoint, ctl.detail, overlay):
                if item["kind"] == "sep":
                    menu.append(Gtk.SeparatorMenuItem())
                elif item["kind"] == "text":
                    entry = Gtk.MenuItem(label=item["label"])
                    entry.set_sensitive(False)
                    menu.append(entry)
                else:
                    entry = Gtk.MenuItem(label=item["label"])
                    entry.set_sensitive(bool(item["enabled"]))
                    entry.connect("activate",
                                  lambda _w, action=item["id"]: self._click(action))
                    menu.append(entry)
            menu.show_all()
            if self.flavor == "ayatana":
                self.indicator.set_menu(menu)
            else:
                self.indicator.connect(
                    "popup-menu",
                    lambda _icon, button, time: menu.popup(
                        None, None, None, None, button, time))
            try:
                self.indicator.set_tooltip_text(
                    f"AIPSTER Worker — {st.STATE_TEXT[ctl.state]}")
            except Exception:  # noqa: BLE001 - tooltip is cosmetic
                pass
        except Exception as exc:  # noqa: BLE001 - menu must never break us
            self.log(f"backend=linux-indicator menu failed: {exc}")

    def _click(self, action):
        if self.controller is None:
            return
        try:
            self.controller.menu_action(action)
        except Exception as exc:  # noqa: BLE001 - UI must survive action errors
            self.log(f"backend=linux-indicator action {action} failed: {exc}")

    def refresh(self, state, detail=""):
        super().refresh(state, detail)
        self._rebuild_menu()
