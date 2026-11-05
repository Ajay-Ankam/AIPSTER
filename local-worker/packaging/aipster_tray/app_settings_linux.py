"""User-selected fabric client address, separate from runtime/pairing settings.

This records an operator assertion, not a verified connection or inference claim.
It never probes a URL, handles a credential, or starts/stops a service.
"""
import ipaddress
import json
import os
from pathlib import Path
import stat
import tempfile
from urllib.parse import urlsplit, urlunsplit

SETTINGS_FILE = "app-settings.json"
MAX_SETTINGS_BYTES = 16384


class SettingsError(ValueError):
    """Invalid or unreadable app settings; safe for display to the user."""


def _authority(parts):
    try:
        port = parts.port
    except ValueError as exc:
        raise SettingsError("Enter a valid port between 1 and 65535.") from exc
    if port is not None and not 1 <= port <= 65535:
        raise SettingsError("Enter a valid port between 1 and 65535.")
    host = (parts.hostname or "").lower()
    if not host:
        raise SettingsError("Enter a fabric hostname.")
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host == "localhost"
    rendered = "[" + host + "]" if ":" in host else host
    if port is not None:
        rendered += ":" + str(port)
    return host, port, loopback, rendered


def validate_fabric_url(raw, control_url=""):
    """Normalize an explicit fabric base to /v1; reject control endpoints.

    Syntax cannot establish that an arbitrary server is the fabric. The caller
    must obtain the explicit operator assertion used by save_settings.
    """
    if not isinstance(raw, str):
        raise SettingsError("Enter a fabric address as text.")
    raw = raw.strip()
    if not raw:
        return ""
    if len(raw) > 2048 or any(ord(c) <= 32 or ord(c) == 127 for c in raw):
        raise SettingsError("The fabric address contains whitespace or is too long.")
    if "\\" in raw:
        raise SettingsError("Use a normal HTTPS fabric address without backslashes.")
    try:
        parts = urlsplit(raw)
        host, port, loopback, authority = _authority(parts)
    except ValueError as exc:
        if isinstance(exc, SettingsError):
            raise
        raise SettingsError("Enter a valid fabric address.") from exc
    if parts.scheme not in ("https", "http"):
        raise SettingsError("Use HTTPS, or HTTP for a loopback fabric proxy.")
    if parts.scheme == "http" and not loopback:
        raise SettingsError("HTTP is allowed only for a loopback fabric proxy.")
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise SettingsError("Do not include credentials, query parameters, or fragments.")
    if parts.path not in ("", "/", "/v1", "/v1/"):
        raise SettingsError("Use the fabric OpenAI base address ending in /v1, not a model or control route.")
    if control_url:
        try:
            control = urlsplit(control_url)
            chost, cport, cloopback, _ = _authority(control)
            effective = port or (443 if parts.scheme == "https" else 80)
            ceffective = cport or (443 if control.scheme == "https" else 80)
            try:
                # A wildcard bind (0.0.0.0 / ::) also serves on loopback.
                cwildcard = ipaddress.ip_address(chost).is_unspecified
            except ValueError:
                cwildcard = False
            same_host = host == chost or (loopback and (cloopback or cwildcard))
            if same_host and effective == ceffective:
                raise SettingsError("This is the worker control address. Supply the fabric address instead.")
        except SettingsError:
            raise
        except ValueError:
            pass
    return urlunsplit((parts.scheme, authority, "/v1", "", ""))


def _result(url="", confirmed=False):
    return {"fabric_base_url": url, "fabric_confirmed": bool(confirmed and url),
            "status": "configured_unverified" if url else "not_configured"}


def load_settings(data_dir):
    """Return validated settings; absent file is the unconfigured state."""
    path = Path(data_dir) / SETTINGS_FILE
    try:
        # Same posture as the other private stores: no links, own regular file.
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return _result()
    except OSError as exc:
        raise SettingsError("Unable to read app settings.") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (
                hasattr(os, "getuid") and info.st_uid != os.getuid()):
            raise SettingsError("App settings are invalid. Open Settings to replace them.")
        with os.fdopen(fd, "rb") as stream:
            fd = None
            content = stream.read(MAX_SETTINGS_BYTES + 1)
    except SettingsError:
        raise
    except OSError as exc:
        raise SettingsError("Unable to read app settings.") from exc
    finally:
        if fd is not None:
            os.close(fd)
    if len(content) > MAX_SETTINGS_BYTES:
        raise SettingsError("App settings file is too large.")
    try:
        value = json.loads(content)
        if not isinstance(value, dict):
            raise ValueError("not an object")
        url = validate_fabric_url(value.get("fabric_base_url", ""))
        confirmed = value.get("fabric_confirmed") is True
        if url and not confirmed:
            raise ValueError("missing operator confirmation")
    except (ValueError, TypeError, UnicodeError) as exc:
        raise SettingsError("App settings are invalid. Open Settings to replace them.") from exc
    return _result(url, confirmed)


def save_settings(data_dir, url, confirmed, control_url=""):
    """Atomically save private app settings; empty address clears them."""
    url = validate_fabric_url(url, control_url)
    if url and confirmed is not True:
        raise SettingsError("Confirm this is a fabric OpenAI address, not a direct model or worker control address.")
    value = _result(url, confirmed)
    directory = Path(data_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".app-settings-", dir=str(directory))
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump({"version": 1, **value}, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / SETTINGS_FILE)
        temporary = None
    except OSError as exc:
        raise SettingsError("Unable to save app settings.") from exc
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
    return value
