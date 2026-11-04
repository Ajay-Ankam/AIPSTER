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
import time
from pathlib import Path

from . import linux_external as ext
from . import state as st
from .backend_base import Backend

# /healthz answers are cached so a busy port never blocks the UI on every
# render; the probe itself is the controller's 1.5 s loopback check.
EXTERNAL_PROBE_TTL = 5.0
COPY_FABRIC_LABEL = "Copy fabric base URL"
FABRIC_CONFIGURED_NOTE = "Fabric address configured; connection and inference are not verified."
EXTERNAL_CONTROL_NOTE = ("The worker on this computer is managed outside this app. "
                         "This app will not start, stop, or replace it.")
SETTINGS_UNAVAILABLE_NOTE = "Settings are unavailable in this desktop mode."

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


# No verified public fabric endpoint ships in this tree (the fabric
# OpenAI route/proxy is unmerged and production deployment is disabled;
# the coordinator resolves the fabric source). Until a verified endpoint
# lands, the desktop must show that explicitly and must never copy the
# local serving address as if it were an endpoint.
ENDPOINT_UNAVAILABLE_NOTE = (
    "Fabric endpoint not configured. Open Settings to add your fabric OpenAI base URL.")


def verified_share_endpoint():
    """Shareable endpoint text, or '' when none is verified. Always '' here."""
    return ""


def find_window_icon():
    """Absolute path of the app icon PNG for the window, or None.

    Prefers the icon bundled beside the frozen exes, then the installed
    hicolor theme paths. Never raises; missing icons are cosmetic.
    """
    candidates = []
    try:
        from .firstrun import bundle_dir
        candidates.append(bundle_dir() / "icons" / "aipster-worker.png")
    except Exception:  # noqa: BLE001 - cosmetic only
        pass
    for size in ("64x64", "48x48", "32x32", "256x256"):
        candidates.append(Path("/usr/share/icons/hicolor") / size / "apps"
                          / "aipster-worker.png")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            pass
    return None


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

    # -- shared view model (window + indicator parity) ---------------------
    def configured_fabric_endpoint(self):
        """Operator-asserted fabric base URL, or ''. Never verified readiness."""
        from .app_settings_linux import load_settings, validate_fabric_url
        if self.controller is None:
            return ""
        try:
            value = load_settings(self.controller.data)
            if not value.get("fabric_confirmed"):
                return ""
            return validate_fabric_url(value.get("fabric_base_url", ""),
                                       self.controller.endpoint_label())
        except (ValueError, OSError):
            return ""

    def external_health(self, state):
        """True only when the port is busy AND its holder answers /healthz ok.

        Read-only loopback GET via the controller's own probe; never touches
        systemd or any service. Cached for EXTERNAL_PROBE_TTL seconds.
        """
        ctl = self.controller
        loaded = getattr(ctl, "loaded", None) if ctl is not None else None
        if state != st.PORT_BUSY or loaded is None:
            return False
        key = (loaded.node.host, loaded.node.port)
        now = time.monotonic()
        cached = getattr(self, "_health_cache", None)
        if cached and cached[0] == key and now - cached[1] < EXTERNAL_PROBE_TTL:
            return cached[2]
        probe = getattr(self, "health_probe", None)
        if probe is None:
            from .controller import _health_ok as probe
        try:
            ok = bool(probe(*key))
        except Exception:  # noqa: BLE001 - unknown health is not healthy
            ok = False
        self._health_cache = (key, now, ok)
        return ok

    def view_model(self, state, detail=""):
        """Header, notes and action items shared by window and indicator."""
        ctl = self.controller
        overlay = ctl.pairing or {"key": st.PAIR_UNPAIRED, "line": st.UNPAIRED_LINE,
                                  "sender": "Sender: stopped"}
        endpoint = self.configured_fabric_endpoint()
        healthy = self.external_health(state)
        loaded = getattr(ctl, "loaded", None)
        host = loaded.node.host if loaded is not None else ""
        port = loaded.node.port if loaded is not None else 0
        # The local serving address is never passed as the endpoint.
        items = st.menu_model(state, "", detail, overlay)
        header, external_note, items = ext.present(state, detail, host, port,
                                                   healthy, items)
        fabric_items = []
        for item in items:
            if item.get("kind") == "action" and item.get("id") == "copy_endpoint":
                item = dict(item, enabled=bool(endpoint), label=COPY_FABRIC_LABEL)
            fabric_items.append(item)
        self.external_key = ext.classify(state, healthy)
        return {"header": header, "external_note": external_note,
                "endpoint": endpoint, "overlay": overlay, "items": fabric_items,
                "endpoint_note": FABRIC_CONFIGURED_NOTE if endpoint
                else ENDPOINT_UNAVAILABLE_NOTE}

    def save_fabric_settings(self, url, confirmed):
        """(ok, message) for a settings Save; writes app-settings.json only."""
        from .app_settings_linux import save_settings
        try:
            value = save_settings(self.controller.data, url, confirmed,
                                  self.controller.endpoint_label())
        except (ValueError, OSError) as exc:
            return False, str(exc)
        return True, ("Fabric address saved; readiness is not verified."
                      if value.get("fabric_base_url") else "Fabric address cleared.")

    def open_app_settings(self):
        """Native app settings; base has no UI surface, so it says so."""
        self.note_to_user(SETTINGS_UNAVAILABLE_NOTE)
        return None

    def copy_fabric(self):
        endpoint = self.configured_fabric_endpoint()
        if not endpoint:
            self.note_to_user("No fabric endpoint configured. Open Settings first.")
            return False
        if self.copy_text(endpoint):
            self.note_to_user("Fabric base URL copied. Connection and inference are not verified.")
            return True
        self.note_to_user("Clipboard unavailable. The configured address remains visible.")
        return False

    def handle_action(self, action):
        """Route one UI action. Settings never depend on config.toml loading;
        start/stop are refused while a healthy external worker owns the port."""
        if self.controller is None:
            return
        if action == "copy_endpoint":
            self.copy_fabric()
        elif action == "settings":
            self.open_app_settings()
        elif action in ("start", "stop") and \
                getattr(self, "external_key", "") == ext.EXTERNAL_HEALTHY:
            self.log(f"backend={self.name} {action} refused: externally managed worker")
            self.note_to_user(EXTERNAL_CONTROL_NOTE)
        else:
            self.controller.menu_action(action)


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
        self._icon_photo = None

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
            # className pins WM_CLASS so the taskbar groups the window under
            # the installed desktop entry (StartupWMClass=aipster-worker).
            self.root = tk.Tk(className="aipster-worker")
        except Exception as exc:  # noqa: BLE001 - no display, wrong $DISPLAY, ...
            self.log(f"backend=linux-window cannot open display: {exc}; "
                     "continuing windowless (CLI control only)")
            self.root = None
            return
        try:
            self.root.tk.call("tk", "appname", "aipster-worker")
        except Exception as exc:  # noqa: BLE001 - cosmetic only
            self.log(f"backend=linux-window appname failed: {exc}")
        self.root.title("AIPSTER Worker")
        self.root.resizable(True, False)
        # Labels wrap at 420px, so never let the window shrink narrower.
        self.root.minsize(440, 0)
        icon_path = find_window_icon()
        if icon_path is not None:
            try:
                photo = tk.PhotoImage(file=str(icon_path))
                self.root.iconphoto(True, photo)
                self._icon_photo = photo  # Tk holds pixels weakly; keep ours
                self.log(f"backend=linux-window icon {icon_path}")
            except Exception as exc:  # noqa: BLE001 - icon is cosmetic
                self.log(f"backend=linux-window icon failed {icon_path}: {exc}")
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
        # Initial render: prepare() already set STOPPED before this backend
        # attached, and with no auto-start (no elected demo runtime) no state
        # transition follows — without this the window stays blank gray.
        self.refresh_current()
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
        sender_line = tk.Label(root, text="", anchor="w", justify="left", wraplength=420)
        sender_line.pack(fill="x", padx=12)
        endpoint_note = tk.Label(root, text="", anchor="w", justify="left",
                                 wraplength=420)
        endpoint_note.pack(fill="x", padx=12)
        note = tk.Label(root, text="", anchor="w", justify="left", wraplength=420,
                        fg="red")
        note.pack(fill="x", padx=12)
        buttons = tk.Frame(root)
        buttons.pack(fill="x", padx=12, pady=12)
        self.widgets = {"header": header, "endpoint": endpoint, "detail": detail,
                        "pair_line": pair_line, "sender_line": sender_line,
                        "endpoint_note": endpoint_note,
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

    def copy_text(self, text):
        # Native Tk clipboard first: external helpers (xclip/xsel/wl-copy)
        # are often absent on minimal desktops. The tray owns the selection
        # while it runs, so no persistence helper is needed.
        if self.root is not None:
            try:
                self.root.clipboard_clear()
                self.root.clipboard_append(str(text))
                self.events.append(("copy_text", str(text)))
                self.log("backend=linux-window copy_text via Tk clipboard")
                return True
            except Exception as exc:  # noqa: BLE001 - fall back to helpers
                self.log(f"backend=linux-window Tk clipboard failed: {exc}")
        return super().copy_text(text)

    def _render(self, state, detail):
        import tkinter as tk
        # Only the operator-asserted fabric address may be shown or copied
        # as the endpoint (labelled unverified). The local serving address
        # is never passed as the endpoint. A busy port whose holder answers
        # /healthz is shown as externally managed, never as broken.
        view = self.view_model(state, detail)
        endpoint = view["endpoint"]
        overlay = view["overlay"]
        self.widgets["header"].config(text=view["header"])
        self.widgets["endpoint"].config(text=endpoint)
        self.widgets["endpoint_note"].config(text=view["endpoint_note"])
        shown_detail = "\n".join(t for t in (view["external_note"], detail) if t)
        self.widgets["detail"].config(text=shown_detail)
        self.widgets["pair_line"].config(text=overlay.get("line", ""))
        self.widgets["sender_line"].config(text=overlay.get("sender", ""))
        self.widgets["note"].config(text=self.note_text)
        frame = self.widgets["buttons"]
        for child in frame.winfo_children():
            child.destroy()
        self.widgets["action_buttons"] = {}
        for item in view["items"]:
            if item["kind"] != "action":
                continue
            button = tk.Button(frame, text=item["label"],
                               state="normal" if item["enabled"] else "disabled",
                               command=lambda action=item["id"]: self._click(action))
            button.pack(fill="x", pady=1)
            self.widgets["action_buttons"][item["id"]] = button

    def open_app_settings(self):
        return self.open_config()

    def open_config(self, path=None):
        """Native app preferences; never writes worker runtime or pairing files."""
        if self.controller is None:
            return None
        if self.root is None:  # windowless (no display or no tkinter)
            self.note_to_user(SETTINGS_UNAVAILABLE_NOTE)
            return None
        import tkinter as tk
        from .app_settings_linux import load_settings
        previous = getattr(self, "settings_window", None)
        if previous is not None and previous.winfo_exists():
            previous.lift()
            return previous
        dialog = tk.Toplevel(self.root)
        self.settings_window = dialog
        dialog.title("AIPSTER Worker Settings")
        dialog.transient(self.root)
        dialog.resizable(True, False)
        try:
            saved = load_settings(self.controller.data)
            settings_error = ""
        except ValueError as exc:
            saved = {}
            settings_error = str(exc)
        url = tk.StringVar(dialog, saved.get("fabric_base_url", ""))
        confirmed = tk.BooleanVar(dialog, saved.get("fabric_confirmed", False))
        tk.Label(dialog, text="Fabric OpenAI base URL", anchor="w").pack(fill="x", padx=16, pady=(16,4))
        entry = tk.Entry(dialog, textvariable=url, width=64)
        entry.pack(fill="x", padx=16)
        tk.Label(dialog, text="Use the fabric gateway or local fabric proxy address ending in /v1.\nDo not enter a model-server URL, worker control URL, or API key.",
                 justify="left", wraplength=480).pack(fill="x", padx=16, pady=8)
        tk.Checkbutton(dialog, text="I confirm this address routes through the AIPSTER fabric",
                       variable=confirmed).pack(anchor="w", padx=12)
        tk.Label(dialog, text="Saving an address does not start services or verify inference.\nYour coding client supplies its own fabric API key.",
                 justify="left", wraplength=480).pack(fill="x", padx=16, pady=8)
        feedback = tk.StringVar(dialog, settings_error)
        tk.Label(dialog, textvariable=feedback, fg="red", wraplength=480,
                 justify="left").pack(fill="x", padx=16)
        def save():
            ok, message = self.save_fabric_settings(url.get(), confirmed.get())
            if not ok:
                feedback.set(message)
                return
            dialog.destroy()
            self.note_to_user(message)
        buttons = tk.Frame(dialog)
        buttons.pack(fill="x", padx=16, pady=16)
        tk.Button(buttons, text="Save", command=save).pack(side="right")
        tk.Button(buttons, text="Cancel", command=dialog.destroy).pack(side="right", padx=8)
        self.settings_widgets = {"url": url, "confirmed": confirmed,
                                 "feedback": feedback, "save": save}
        entry.focus_set()
        return dialog

    def _click(self, action):
        if self.controller is None:
            return
        try:
            self.handle_action(action)
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
        # Same view model as the window: operator-asserted fabric address
        # (labelled unverified), externally managed status, never the local
        # serving address as the endpoint.
        view = self.view_model(ctl.state, ctl.detail)
        try:
            import gi
            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk
            menu = Gtk.Menu()
            for item in self.menu_items(view):
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
            self.menu = menu
            if self.flavor == "ayatana":
                self.indicator.set_menu(menu)
            elif not getattr(self, "_popup_connected", False):
                # Connect once; the handler pops whichever menu is current, so
                # rebuilds never stack duplicate popup handlers.
                self.indicator.connect(
                    "popup-menu",
                    lambda _icon, button, when: self.menu.popup(
                        None, None, None, None, button, when))
                self._popup_connected = True
            try:
                self.indicator.set_tooltip_text(view["header"])
            except Exception:  # noqa: BLE001 - tooltip is cosmetic
                pass
        except Exception as exc:  # noqa: BLE001 - menu must never break us
            self.log(f"backend=linux-indicator menu failed: {exc}")

    @staticmethod
    def menu_items(view):
        """menu_model items plus the fabric/external lines the window shows."""
        lines = [view["external_note"],
                 (f"Fabric: {view['endpoint']} (not verified)" if view["endpoint"]
                  else view["endpoint_note"])]
        extra = [{"kind": "text", "label": text} for text in lines if text]
        items = list(view["items"])
        return items[:1] + extra + items[1:]

    def note_to_user(self, message):
        super().note_to_user(message)
        # No status surface in a menu: notes go to a desktop notification.
        send_notification("AIPSTER Worker", str(message))

    def open_app_settings(self):
        """Native Gtk settings dialog (the indicator has no Tk root)."""
        from .app_settings_linux import load_settings
        if self.controller is None:
            return None
        try:
            import gi
            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk
        except (ImportError, ValueError, AttributeError) as exc:
            self.log(f"backend=linux-indicator settings unavailable: {exc}")
            self.note_to_user(SETTINGS_UNAVAILABLE_NOTE)
            return None
        previous = getattr(self, "settings_window", None)
        if previous is not None:
            try:
                previous.present()
                return previous
            except Exception:  # noqa: BLE001 - stale dialog; build a new one
                self.settings_window = None
        try:
            saved = load_settings(self.controller.data)
            error = ""
        except ValueError as exc:
            saved, error = {}, str(exc)
        dialog = Gtk.Dialog(title="AIPSTER Worker Settings")
        box = dialog.get_content_area()
        box.set_spacing(8)
        box.set_border_width(16)
        box.add(Gtk.Label(label="Fabric OpenAI base URL", xalign=0))
        entry = Gtk.Entry()
        entry.set_width_chars(64)
        entry.set_text(saved.get("fabric_base_url", ""))
        box.add(entry)
        box.add(Gtk.Label(label=("Use the fabric gateway or local fabric proxy address "
                                 "ending in /v1.\nDo not enter a model-server URL, "
                                 "worker control URL, or API key."), xalign=0))
        check = Gtk.CheckButton(
            label="I confirm this address routes through the AIPSTER fabric")
        check.set_active(bool(saved.get("fabric_confirmed", False)))
        box.add(check)
        box.add(Gtk.Label(label=("Saving an address does not start services or verify "
                                 "inference.\nYour coding client supplies its own "
                                 "fabric API key."), xalign=0))
        feedback = Gtk.Label(label=error, xalign=0)
        box.add(feedback)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Save", Gtk.ResponseType.OK)

        def respond(widget, response):
            if response != Gtk.ResponseType.OK:
                widget.destroy()
                self.settings_window = None
                return
            ok, message = self.save_fabric_settings(entry.get_text(), check.get_active())
            if not ok:
                feedback.set_text(message)
                return
            widget.destroy()
            self.settings_window = None
            self.note_to_user(message)
            self._rebuild_menu()

        dialog.connect("response", respond)
        dialog.show_all()
        self.settings_window = dialog
        return dialog

    def _click(self, action):
        if self.controller is None:
            return
        try:
            self.handle_action(action)
        except Exception as exc:  # noqa: BLE001 - UI must survive action errors
            self.log(f"backend=linux-indicator action {action} failed: {exc}")
        self._rebuild_menu()

    def refresh(self, state, detail=""):
        super().refresh(state, detail)
        self._rebuild_menu()
