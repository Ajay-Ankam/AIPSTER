# PyInstaller spec for the AIPSTER Worker (Linux). Three executables share one
# directory: `aipster-tray` (desktop tray/window controller, the primary
# desktop entry), `aipster-worker` (console launcher + foreground server +
# tray CLI), and `dendrite` (the reviewed worker CLI: serve/inspect). Always
# built by build.py, which stages AIPSTER_STAGE (default.toml, BUILD.json)
# and runs the venv-installed PyInstaller under its pinned CPython.
import os
from pathlib import Path

LINUXDIR = Path(SPECPATH)  # noqa: F821 - provided by PyInstaller
PACKAGING = LINUXDIR.parent  # aipster_tray lives here (shared with Windows)
WINDOWS = PACKAGING / "windows"  # cli_entry + delivery_check live here
STAGE = Path(os.environ.get("AIPSTER_STAGE", LINUXDIR))

# uvicorn's protocol/lifespan/loop implementations are resolved dynamically at
# runtime; Analysis cannot see them, so they are listed explicitly. Everything
# else is found by static analysis from the dendrite package.
UVICORN_HIDDEN = [
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
]


def _tcltk_binaries():
    """Tcl/Tk shared libs for the frozen Tk window backend.

    The pinned CPython layout keeps libtcl/libtk beside the install (not on
    the loader path PyInstaller's tkinter hook searches), so the hook
    collects the data files but misses the .so files. build.py passes
    AIPSTER_TCLTK_LIB=<python base prefix>/lib; the tray analysis (the only
    tkinter user) bundles them, and fails loudly when they are absent.
    """
    lib_dir = os.environ.get("AIPSTER_TCLTK_LIB", "")
    if not lib_dir:
        return []
    found = []
    for name in ("libtcl9.0.so", "libtcl9tk9.0.so"):
        candidate = Path(lib_dir) / name
        if not candidate.is_file():
            raise SystemExit(f"missing Tcl/Tk runtime for frozen tkinter: {candidate}")
        found.append((str(candidate), "."))
    return found


def analysis(script, datas=(), hidden=(), binaries=()):
    return Analysis(  # noqa: F821
        [str(script)],
        pathex=[str(PACKAGING), str(PACKAGING.parent), str(WINDOWS)],
        binaries=list(binaries),
        datas=list(datas),
        hiddenimports=list(hidden),
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        # NOTE: tkinter is required by the Linux window fallback backend, so
        # it is deliberately NOT excluded here (unlike the Windows spec).
        excludes=["unittest", "pydoc", "test"],
        noarchive=False,
    )


launcher = analysis(LINUXDIR / "launcher.py",
                    [(str(STAGE / "default.toml"), "."), (str(STAGE / "BUILD.json"), ".")],
                    UVICORN_HIDDEN)
cli = analysis(WINDOWS / "cli_entry.py", [], UVICORN_HIDDEN)
tray = analysis(LINUXDIR / "tray_entry.py", binaries=_tcltk_binaries())

launcher_pyz = PYZ(launcher.pure)  # noqa: F821
cli_pyz = PYZ(cli.pure)  # noqa: F821
tray_pyz = PYZ(tray.pure)  # noqa: F821

exe_options = dict(
    exclude_binaries=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
    # Flat onedir layout: datas (default.toml, BUILD.json) land beside the
    # exes, where the launcher expects them, instead of in _internal/.
    contents_directory=".",
)
launcher_exe = EXE(launcher_pyz, launcher.scripts, [], name="aipster-worker",  # noqa: F821,E501
                   console=True, **exe_options)
# NOTE: the CLI exe is named aipster-dendrite, not dendrite: a frozen exe
# named `dendrite` would shadow the `dendrite/` package directory inside the
# bundle (PyInstaller's path hook refuses paths that are existing files, so
# every `dendrite.*` submodule import would fail). The .exe suffix saves the
# Windows build from the same collision.
cli_exe = EXE(cli_pyz, cli.scripts, [], name="aipster-dendrite", console=True, **exe_options)  # noqa: F821,E501
tray_exe = EXE(tray_pyz, tray.scripts, [], name="aipster-tray", console=True,  # noqa: F821,E501
               **exe_options)

coll = COLLECT(  # noqa: F821
    launcher_exe,
    cli_exe,
    tray_exe,
    launcher.binaries,
    launcher.datas,
    cli.binaries,
    cli.datas,
    tray.binaries,
    tray.datas,
    strip=False,
    upx=False,  # UPX packing hurts reproducibility and trips antivirus heuristics
    upx_exclude=[],
    name="app",
)
