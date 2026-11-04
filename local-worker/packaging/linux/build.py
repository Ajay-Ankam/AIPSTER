"""Build the Ubuntu x86-64 AIPSTER Worker DEB.

Pipeline: verify vendor tree -> fresh CPython 3.12 venv -> hash-locked
dependency install (the same `uv pip install --require-hashes
--only-binary` invocation as install.py) -> unit tests -> PyInstaller
freeze -> license/icon assembly -> dpkg-deb package -> manifest +
checksums.

Outputs land in packaging/linux/dist/ (gitignored):
  aipster-worker-<version>-<build>_amd64.deb, manifest.json, SHA256SUMS.

Prerequisites: Linux x86-64 (Ubuntu 22.04+), `uv` on PATH, `dpkg-deb` on
PATH, network access to pypi.org. Nothing is uploaded anywhere, and
nothing is installed system-wide: the build venv and staging live under
packaging/linux/build/.
"""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGING = HERE.parent
ROOT = PACKAGING.parent  # local-worker/
REPO = ROOT.parent
INSTALLER_BUILD = "1"
REQUIRED_PYTHON = "3.12"

APP_DIR_NAME = "app"
DEB_LIB_DIR = "usr/lib/aipster-worker"

ENV_ALLOW = {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
             "UV_PYTHON_INSTALL_DIR", "UV_CACHE_DIR"}


def step(number, total, message):
    print(f"[step {number}/{total}] {message}", flush=True)


def clean_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k.upper() in ENV_ALLOW}
    env.update(UV_NO_CONFIG="1", UV_NO_CACHE="1", UV_KEYRING_PROVIDER="disabled",
               PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
    if extra:
        env.update(extra)
    return env


def run(cmd, env, cwd=ROOT):
    print("+ " + " ".join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, env=env, cwd=cwd, check=True)


def worker_version():
    text = (ROOT / "vendor/eif/pyproject.toml").read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("version"):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit("cannot parse worker version from vendor/eif/pyproject.toml")


def worker_commit():
    try:
        provenance = json.loads((ROOT / "provenance.json").read_text(encoding="utf-8"))
        for key in ("worker_commit", "source_commit", "commit", "pin"):
            if provenance.get(key):
                return str(provenance[key])
    except (OSError, ValueError):
        pass
    return "unknown (see vendor/eif provenance)"


def git_info():
    def out(*args):
        return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()
    try:
        return {"sha": out("rev-parse", "HEAD"),
                "dirty": bool(out("status", "--short")),
                "branch": out("rev-parse", "--abbrev-ref", "HEAD")}
    except (OSError, subprocess.CalledProcessError):
        return {"sha": "unknown", "dirty": None, "branch": "unknown"}


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_python_license(python_home, license_dir):
    """Copy the pinned CPython license when the distribution ships one."""
    home = Path(python_home)
    for candidate in (home / "LICENSE.txt", home.parent / "LICENSE.txt",
                      home / "LICENSE", home / "lib" / "LICENSE.txt"):
        if candidate.is_file():
            shutil.copy2(candidate, license_dir / "CPYTHON-LICENSE.txt")
            return str(candidate)
    # python-build-standalone layouts keep third-party notices elsewhere;
    # record the absence instead of failing the build.
    (license_dir / "CPYTHON-LICENSE.txt").write_text(
        "The pinned CPython distribution used for this build does not ship a\n"
        "top-level LICENSE.txt at a discoverable path; CPython is distributed\n"
        "under the PSF license (https://docs.python.org/3/license.html).\n"
        f"Distribution base prefix: {python_home}\n", encoding="utf-8")
    return None


def ldd_needed(path):
    """DT_NEEDED library names for an ELF file (via ldd)."""
    try:
        proc = subprocess.run(["ldd", str(path)], capture_output=True, text=True)
    except OSError:
        return set()
    needed = set()
    for line in proc.stdout.splitlines():
        match = re.match(r"\s*\S+ => (\S+) \(", line)
        if match:
            needed.add(match.group(1))
        else:
            match = re.match(r"\s*(/lib\S+|/usr/lib\S+)", line)
            if match:
                needed.add(match.group(1))
    return needed


def system_depends(app_dir):
    """Debian package names for bundled ELF NEEDED libs outside libc6.

    Maps every NEEDED path found under the frozen payload to its owning
    Debian package via `dpkg -S`. libc6 (always present) is excluded; the
    remainder (typically X11/Tk libs) becomes the control Depends.
    """
    libs = set()
    for path in app_dir.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            with open(path, "rb") as handle:
                if handle.read(4) != b"\x7fELF":
                    continue
        except OSError:
            continue
        libs |= ldd_needed(path)
    packages = set()
    for lib in sorted(libs):
        if not lib.startswith(("/lib/", "/usr/lib/")):
            continue
        try:
            proc = subprocess.run(["dpkg", "-S", lib], capture_output=True, text=True)
        except OSError:
            continue
        if proc.returncode != 0:
            continue
        owner = proc.stdout.split(":", 1)[0].strip()
        if owner and owner not in ("libc6:amd64", "libc6", "libc-bin:amd64", "libc-bin"):
            packages.add(owner)
    return sorted(packages)


def stage_deb_tree(deb_root, app_dir, version, depends):
    """Assemble the DEB data tree (payload only; DEBIAN/ added by caller)."""
    lib_app = deb_root / DEB_LIB_DIR / APP_DIR_NAME
    shutil.copytree(app_dir, lib_app, symlinks=True)
    bin_dir = deb_root / "usr/bin"
    bin_dir.mkdir(parents=True)
    # /usr/bin entries are wrappers, not symlinks: the frozen exes have no
    # RUNPATH, so the private Tcl/Tk libs in the app dir resolve only with
    # LD_LIBRARY_PATH pointed at it. The wrapper keeps that deterministic on
    # any target machine (no ldconfig, no environment assumptions), and the
    # tray's own supervised children need no such variable (they import no
    # Tk). "$@" preserves every argument verbatim.
    for name in ("aipster-worker", "aipster-tray", "aipster-dendrite"):
        target = f"/{DEB_LIB_DIR}/{APP_DIR_NAME}/{name}"
        wrapper = bin_dir / name
        wrapper.write_text(
            "#!/bin/sh\n"
            "# AIPSTER Worker launcher wrapper (generated by packaging/linux/build.py).\n"
            f"export LD_LIBRARY_PATH=\"/{DEB_LIB_DIR}/{APP_DIR_NAME}"
            "${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\"\n"
            f"exec \"{target}\" \"$@\"\n", encoding="utf-8")
        wrapper.chmod(0o755)
    applications = deb_root / "usr/share/applications"
    applications.mkdir(parents=True)
    shutil.copy2(HERE / "desktop/aipster-worker.desktop", applications)
    for size_dir in sorted((HERE / "icons/hicolor").iterdir()):
        target = deb_root / "usr/share/icons" / "hicolor" / size_dir.name / "apps"
        target.mkdir(parents=True)
        shutil.copy2(size_dir / "apps/aipster-worker.png", target)
    doc = deb_root / "usr/share/doc/aipster-worker"
    doc.mkdir(parents=True)
    shutil.copy2(HERE / "deb/copyright", doc / "copyright")
    shutil.copy2(HERE / "deb/README.Debian", doc)
    return lib_app


def write_control(deb_root, version, depends):
    debian = deb_root / "DEBIAN"
    debian.mkdir()
    template = (HERE / "deb/control").read_text(encoding="utf-8")
    debian_version = f"{version}-{INSTALLER_BUILD}"
    control = template.replace("@VERSION@", debian_version)
    control = control.replace("@DEPENDS@", ", ".join(depends) if depends else "libc6")
    (debian / "control").write_text(control, encoding="utf-8")
    for name in ("postinst", "prerm", "postrm"):
        script = debian / name
        shutil.copy2(HERE / "deb" / name, script)
        script.chmod(0o755)
    return debian_version


def normalize_mtimes(root, epoch):
    for path in root.rglob("*"):
        try:
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        except OSError:
            pass
    try:
        os.utime(root, (epoch, epoch), follow_symlinks=False)
    except OSError:
        pass


def payload_files(root):
    return sorted(p for p in root.rglob("*")
                  if (p.is_file() or p.is_symlink()) and "DEBIAN" not in p.parts)


def main():
    total = 11
    if os.name != "posix" or platform.machine() not in ("x86_64", "AMD64"):
        raise SystemExit("this script builds the Linux x86-64 package only")
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("uv is required on PATH")
    uv_version = subprocess.check_output([uv, "--version"], text=True).split()[1]
    if not shutil.which("dpkg-deb"):
        raise SystemExit("dpkg-deb is required on PATH")
    version = worker_version()
    artifact = f"aipster-worker-{version}-{INSTALLER_BUILD}_amd64.deb"
    build_dir = HERE / "build"
    dist_dir = HERE / "dist"
    git = git_info()
    print(f"worker {version} (commit {worker_commit()}), installer build {INSTALLER_BUILD}")
    print(f"source {git['sha']} branch {git['branch']} dirty={git['dirty']}")

    step(1, total, "verify vendor tree and patches")
    run([sys.executable, str(ROOT / "verify_vendor.py"), "--check-patches"], clean_env())

    step(2, total, "fresh build directories")
    for directory in (build_dir, dist_dir):
        if not directory.resolve().is_relative_to(HERE.resolve()):
            raise SystemExit("refusing build cleanup outside packaging/linux")
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)

    step(3, total, "create CPython 3.12 build venv")
    netrc = None
    with tempfile.TemporaryDirectory(prefix="aipster-pkg-") as isolated:
        netrc = Path(isolated) / "empty-netrc"
        netrc.write_text("")
        env = clean_env({"NETRC": str(netrc), "UV_CREDENTIALS_DIR": isolated})
        venv = build_dir / "venv"
        run([uv, "python", "install", REQUIRED_PYTHON], env)
        run([uv, "venv", "--python", REQUIRED_PYTHON, str(venv)], env)
        python = venv / "bin/python"
        build_python = subprocess.check_output(
            [str(python), "--version"], text=True, env=env).strip()

        step(4, total, "hash-locked dependency install")
        for lock in ("requirements.lock", "build-requirements.lock"):
            run([uv, "pip", "install", "--python", str(python), "--require-hashes",
                 "--only-binary", ":all:", "--default-index", "https://pypi.org/simple",
                 "-r", str(ROOT / lock)], env)
        run([uv, "pip", "install", "--python", str(python), "--require-hashes",
             "--only-binary", ":all:", "--default-index", "https://pypi.org/simple",
             "-r", str(HERE / "installer-build.lock")], env)
        run([uv, "pip", "install", "--python", str(python), "--no-index", "--no-deps",
             "--no-build-isolation", str(ROOT / "vendor/eif")], env)
        run([uv, "pip", "check", "--python", str(python)], env)
        freeze = subprocess.check_output(
            [uv, "pip", "freeze", "--python", str(python)], text=True, env=env)
        (build_dir / "pip-freeze.txt").write_text(freeze, encoding="utf-8")
        pyinstaller_version = next(
            line.split("==", 1)[1] for line in freeze.splitlines()
            if line.startswith("pyinstaller=="))
        run([str(python), str(HERE / "test_linux_packaging.py")], env)

    step(5, total, "stage freeze inputs")
    stage = build_dir / "stage"
    stage.mkdir()
    shutil.copy2(HERE / "default.toml", stage / "default.toml")
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (stage / "BUILD.json").write_text(json.dumps({
        "worker_name": "ganglion-dendrite",
        "worker_version": version,
        "worker_commit": worker_commit(),
        "installer_build": INSTALLER_BUILD,
        "installer_target": "ubuntu-amd64",
        "source_sha": git["sha"],
        "built_at": built_at,
    }, indent=2), encoding="utf-8")

    step(6, total, "freeze with PyInstaller")
    python_base = subprocess.check_output(
        [str(python), "-c", "import sys; print(sys.base_prefix)"],
        text=True, env=clean_env()).strip()
    tcltk_lib = str(Path(python_base) / "lib")
    for lib_name in ("libtcl9.0.so", "libtcl9tk9.0.so"):
        if not (Path(tcltk_lib) / lib_name).is_file():
            raise SystemExit(
                f"frozen tkinter needs {lib_name} in {tcltk_lib}; refusing a "
                "bundle whose window fallback cannot open")
    freeze_env = clean_env({
        "AIPSTER_STAGE": str(stage),
        "AIPSTER_TCLTK_LIB": tcltk_lib,
        "PATH": f"{venv / 'bin'}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
    })
    run([str(python), "-m", "PyInstaller", str(HERE / "dendrite_linux.spec"),
         "--distpath", str(build_dir / "freeze"), "--workpath", str(build_dir / "pywork"),
         "--noconfirm", "--clean"], freeze_env, cwd=HERE)
    app_dir = build_dir / "freeze" / "app"

    step(7, total, "smoke-test the frozen app (scrubbed environment)")
    # Direct exe invocation (no /usr/bin wrappers here) needs the same
    # private-library path the installed wrappers provide.
    smoke_env = {"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/root"),
                 "LD_LIBRARY_PATH": str(app_dir)}
    with tempfile.TemporaryDirectory(prefix="aipster-smoke-") as temp:
        config = Path(temp) / "mock.toml"
        config.write_text(
            (ROOT / "configs/mock.toml").read_text(encoding="utf-8")
            .replace('state_dir = "../.state"', 'state_dir = "state"'), encoding="utf-8")
        help_proc = subprocess.run([str(app_dir / "aipster-dendrite"), "--help"],
                                   capture_output=True, text=True, env=smoke_env)
        if help_proc.returncode != 0:
            raise SystemExit(f"frozen --help failed: {help_proc.stderr[-2000:]}")
        inspect_proc = subprocess.run(
            [str(app_dir / "aipster-dendrite"), "inspect", "--config", str(config)],
            capture_output=True, text=True, env=smoke_env)
        if inspect_proc.returncode != 0:
            raise SystemExit(f"frozen inspect failed: {inspect_proc.stderr[-2000:]}")
        snapshot = json.loads(inspect_proc.stdout)
        if not snapshot["models"] or not snapshot["models"][0]["simulated"]:
            raise SystemExit(f"frozen inspect is not simulated: {inspect_proc.stdout[:500]}")
        tray = app_dir / "aipster-tray"
        if not tray.exists():
            raise SystemExit("frozen bundle is missing aipster-tray")
        tray_env = dict(smoke_env)
        tray_env["AIPSTER_WORKER_DATA"] = str(Path(temp) / "tray-data")
        help_proc = subprocess.run([str(tray), "--help"], capture_output=True, text=True,
                                   env=tray_env, timeout=60)
        if help_proc.returncode != 0:
            raise SystemExit(f"frozen tray --help failed: rc={help_proc.returncode}")
        status_proc = subprocess.run([str(tray), "status"], capture_output=True, text=True,
                                     env=tray_env, timeout=60)
        if status_proc.returncode != 2:
            raise SystemExit(f"frozen tray status without state: rc={status_proc.returncode}")
        # The pairing module must freeze with the launcher: sender --once on
        # an empty store exercises the frozen import and reports NOT_PAIRED.
        sender_probe = subprocess.run(
            [str(app_dir / "aipster-worker"), "sender", "--once",
             "--data-dir", str(Path(temp) / "sender-data")],
            capture_output=True, text=True, env=tray_env, timeout=60)
        if sender_probe.returncode != 2 or "not paired" not in sender_probe.stderr:
            raise SystemExit(
                "frozen sender --once without pairing: "
                f"rc={sender_probe.returncode} err={sender_probe.stderr[-500:]}")
        # delivery-check on a mock-only store must report blocked (exit 2).
        worker_data = Path(temp) / "tray-data"
        worker_data.mkdir(parents=True)
        (worker_data / "config.toml").write_text(
            (HERE / "default.toml").read_text(encoding="utf-8"), encoding="utf-8")
        delivery_probe = subprocess.run(
            [str(app_dir / "aipster-worker"), "delivery-check",
             "--app-dir", str(app_dir), "--data-dir", str(worker_data)],
            capture_output=True, text=True, env=tray_env, timeout=60)
        if delivery_probe.returncode != 2 or "blocked" not in delivery_probe.stdout:
            raise SystemExit(
                "frozen delivery-check on mock config: "
                f"rc={delivery_probe.returncode} out={delivery_probe.stdout[-500:]}")
        print("frozen --help + simulated inspect + tray --help/status + "
              "sender entry + delivery-check: OK")
        # Frozen Tk window fallback under an isolated display (the user's
        # desktop is never touched). Skipped loudly when xvfb-run is absent.
        if shutil.which("xvfb-run"):
            import socket as _socket
            _probe = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
            _probe.bind(("127.0.0.1", 0))
            _free_port = _probe.getsockname()[1]
            _probe.close()
            window_data = Path(temp) / "window-data"
            window_data.mkdir(parents=True)
            (window_data / "config.toml").write_text(
                (HERE / "default.toml").read_text(encoding="utf-8").replace(
                    "port = 8090", f"port = {_free_port}"), encoding="utf-8")
            window_env = dict(tray_env)
            window_env["AIPSTER_WORKER_DATA"] = str(window_data)
            window_env["AIPSTER_WORKER_MOCK_DEMO"] = "1"
            window_proc = subprocess.Popen(
                ["xvfb-run", "-a", str(app_dir / "aipster-tray")],
                env=window_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                state_file = window_data / "state.json"
                for _ in range(120):
                    if state_file.is_file():
                        break
                    if window_proc.poll() is not None:
                        break
                    time.sleep(0.5)
                if not state_file.is_file():
                    raise SystemExit("frozen tray window run published no state")
                # The window backend attaches after prepare(): poll for its
                # verdict instead of reading the log once (cold-start Tk
                # import under Xvfb takes seconds).
                tray_log_path = window_data / "logs" / "tray.log"
                attached, failed = False, ""
                for _ in range(120):
                    if window_proc.poll() is not None:
                        break
                    tray_log = tray_log_path.read_text(encoding="utf-8")
                    if "backend=linux-window attached" in tray_log:
                        attached = True
                        break
                    if "tkinter unavailable" in tray_log:
                        failed = tray_log
                        break
                    time.sleep(0.5)
                if not attached:
                    raise SystemExit("frozen Tk window did not attach:\n"
                                     + (failed or tray_log_path.read_text(
                                         encoding="utf-8"))[-2000:])
                quit_proc = subprocess.run(
                    [str(app_dir / "aipster-tray"), "quit"],
                    capture_output=True, text=True, env=window_env, timeout=60)
                if quit_proc.returncode != 0:
                    raise SystemExit(
                        f"frozen tray window quit failed: rc={quit_proc.returncode}")
                window_proc.wait(timeout=60)
                if window_proc.returncode != 0:
                    raise SystemExit(
                        f"frozen tray window exit: rc={window_proc.returncode}")
            finally:
                if window_proc.poll() is None:
                    window_proc.terminate()
                    window_proc.wait(timeout=10)
            print("frozen Tk window fallback under Xvfb: OK")
        else:
            print("SKIP frozen Tk window smoke: xvfb-run not on PATH")

    step(8, total, "assemble licenses and icons")
    for size_dir in sorted((HERE / "icons/hicolor").iterdir()):
        if not (size_dir / "apps/aipster-worker.png").is_file():
            raise SystemExit(f"missing app icon: {size_dir}/apps/aipster-worker.png")
    license_dir = app_dir / "licenses"
    (license_dir / "python").mkdir(parents=True)
    shutil.copy2(REPO / "LICENSE", license_dir / "AIPSTER-APACHE-LICENSE.txt")
    shutil.copy2(ROOT / "vendor/eif/LICENSE", license_dir / "DENDRITE-LICENSE")
    shutil.copy2(ROOT / "vendor/eif/NOTICE", license_dir / "DENDRITE-NOTICE")
    shutil.copy2(ROOT / "DEPENDENCIES.json", license_dir / "DEPENDENCIES.json")
    python_home = subprocess.check_output([str(python), "-c", "import sys; print(sys.base_prefix)"], text=True, env=clean_env()).strip()
    python_license_source = copy_python_license(python_home, license_dir)
    (license_dir / "PYINSTALLER-BOOTLOADER-NOTE.txt").write_text(
        "This application was frozen with PyInstaller, which is distributed under\n"
        "GPL-2.0-or-later WITH a bootloader exception. The exception permits the\n"
        "frozen application (bootloader + bundled interpreter + AIPSTER code) to be\n"
        "distributed under the application's own license (Apache-2.0, see\n"
        "AIPSTER-APACHE-LICENSE.txt). No GPL obligations attach to the frozen app\n"
        "beyond this notice. PyInstaller source: https://github.com/pyinstaller/pyinstaller\n",
        encoding="utf-8")
    site_packages = venv / "lib" / f"python{REQUIRED_PYTHON}" / "site-packages"
    copied = 0
    for dist_info in sorted(site_packages.glob("*.dist-info")):
        target = license_dir / "python" / dist_info.name
        for candidate in list(dist_info.glob("licenses/**/*")) + \
                [p for p in dist_info.iterdir() if
                 p.name.upper().startswith(("LICENSE", "NOTICE", "COPYING"))]:
            if not candidate.is_file():
                continue
            relative = candidate.relative_to(dist_info)
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, destination)
            copied += 1
    print(f"copied {copied} third-party license files")

    step(9, total, "stage DEB tree")
    deb_root = build_dir / "deb-root"
    if deb_root.exists():
        shutil.rmtree(deb_root)
    deb_root.mkdir()
    stage_deb_tree(deb_root, app_dir, version, depends=[])
    depends = system_depends(lib_app := deb_root / DEB_LIB_DIR / APP_DIR_NAME)
    print(f"computed Depends: {', '.join(depends) if depends else '(libc6 only)'}")
    debian_version = write_control(deb_root, version, depends)

    step(10, total, "build the DEB (dpkg-deb, owner/group normalized)")
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if epoch:
        # Reproducible build: clamp every staged mtime and let dpkg-deb
        # clamp its control metadata to the same epoch.
        normalize_mtimes(deb_root, int(epoch))
    deb_env = dict(os.environ)
    package = f"aipster-worker_{debian_version}_amd64.deb"
    run(["dpkg-deb", "--root-owner-group", "--build", str(deb_root),
         str(dist_dir / package)], deb_env)
    installer = dist_dir / package

    step(11, total, "manifest and checksums")
    files = [{"path": p.relative_to(deb_root).as_posix(),
              "sha256": sha256_of(p) if not p.is_symlink() else None,
              "link": os.readlink(p) if p.is_symlink() else None,
              "size": p.stat().st_size if not p.is_symlink() else 0}
             for p in sorted(payload_files(deb_root))]
    manifest = {
        "artifact": package,
        "artifact_sha256": sha256_of(installer),
        "artifact_size": installer.stat().st_size,
        "worker_name": "ganglion-dendrite",
        "worker_version": version,
        "worker_commit": worker_commit(),
        "installer_build": INSTALLER_BUILD,
        "installer_target": "ubuntu-amd64",
        "source_sha": git["sha"],
        "source_branch": git["branch"],
        "source_dirty": git["dirty"],
        "toolchain": {"python": build_python, "uv": uv_version,
                      "pyinstaller": pyinstaller_version,
                      "dpkg_deb": subprocess.check_output(
                          ["dpkg-deb", "--version"], text=True).splitlines()[0]},
        "depends": depends,
        "python_license_source": python_license_source,
        "locks": ["requirements.lock", "build-requirements.lock",
                  "packaging/linux/installer-build.lock"],
        "payload_files": len(files),
        "payload_size": sum(f["size"] for f in files),
        "files": files,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (dist_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (dist_dir / "SHA256SUMS").write_text(
        f"{manifest['artifact_sha256']}  {package}\n"
        f"{sha256_of(dist_dir / 'manifest.json')}  manifest.json\n", encoding="utf-8")
    print(f"built {installer} ({manifest['artifact_size']} bytes)")
    print(f"sha256 {manifest['artifact_sha256']}")
    print("dashboard entry needs: version "
          f"{version}, sha256 {manifest['artifact_sha256']}, url set by the release owner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
