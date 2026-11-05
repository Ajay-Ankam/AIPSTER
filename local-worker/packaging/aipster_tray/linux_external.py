"""Externally managed worker status for the Linux UI. Pure; no service calls.

When the configured loopback port is held by another process, the tray must
not spawn a duplicate worker or sender and must not stop or replace the holder.
A /healthz "ok" from that holder proves only that a local worker answers on the
port; it says nothing about who manages it, endpoint readiness, or inference.
This module never runs systemctl and never names a system unit it has not
verified, so it never invents service status.
"""
from . import state as st

EXTERNAL_HEALTHY = "external_healthy"   # port held, /healthz ok
EXTERNAL_UNHEALTHY = "external_unhealthy"  # port held, /healthz not ok
EXTERNAL_DECLARED = "external_declared"  # persistent record; any state

HEALTHY_HEADER = "AIPSTER Worker — Running outside this app (not managed here)"
UNHEALTHY_HEADER = "AIPSTER Worker — Port busy"
HEALTHY_NOTE = ("A worker on this computer answers health checks on {origin}. "
                "It is managed outside this app, so Start and Stop are "
                "unavailable here. Health is local reachability only; endpoint "
                "and inference are not verified.")
UNHEALTHY_NOTE = ("Port {port} is in use by a process that does not answer "
                  "AIPSTER health checks. This app will not stop or replace it.")
CONTROL_UNAVAILABLE = "Managed outside this app"
DECLARED_SUFFIX = " here (managed outside this app)"

# Actions this app must not offer while another process owns the port.
_OWNERSHIP_ACTIONS = ("start", "stop")


def classify(state, health_ok):
    """External ownership key, or "" when this app may own the worker."""
    if state != st.PORT_BUSY:
        return ""
    return EXTERNAL_HEALTHY if health_ok else EXTERNAL_UNHEALTHY


def present(state, detail, host, port, health_ok, items):
    """Return (header, note, items) for the Linux window.

    items is state.menu_model() output; it is copied, never mutated. Only a
    healthy external holder changes start/stop, and only toward disabled:
    nothing is enabled here.
    """
    key = classify(state, health_ok)
    if not key:
        return (f"AIPSTER Worker — {st.STATE_TEXT[state]}", "", list(items))
    if key == EXTERNAL_HEALTHY:
        header = HEALTHY_HEADER
        note = HEALTHY_NOTE.format(origin=st.http_origin(host, port))
    else:
        header = UNHEALTHY_HEADER
        note = UNHEALTHY_NOTE.format(port=port)
    st.check_honest(header)
    st.check_honest(note)
    if key == EXTERNAL_UNHEALTHY:
        # Keep the original explicit Start retry: it only re-probes the port
        # and never stops or replaces the holder; disabling it would trap the
        # user after a dead holder frees the port.
        return header, note, list(items)
    return header, note, disable_ownership(items)


def disable_ownership(items):
    """Copy of items with start/stop disabled; never enables anything."""
    out = []
    for item in items:
        if item.get("kind") == "action" and item.get("id") in _OWNERSHIP_ACTIONS:
            item = dict(item, enabled=False, label=CONTROL_UNAVAILABLE)
        out.append(item)
    return out


def declared_header(state):
    """Header while an external-management record is declared.

    Says only what this app knows: its own state here and that the worker is
    managed elsewhere. No health, readiness or service claim.
    """
    return st.check_honest(f"AIPSTER Worker — {st.STATE_TEXT[state]}{DECLARED_SUFFIX}")


for _t in (HEALTHY_HEADER, UNHEALTHY_HEADER, HEALTHY_NOTE, UNHEALTHY_NOTE,
           CONTROL_UNAVAILABLE, DECLARED_SUFFIX):
    st.check_honest(_t)
del _t
