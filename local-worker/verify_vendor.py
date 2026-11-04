"""Verify the explicit public-source allowlist and recorded local patches.

Unpatched files must match the pinned upstream bytes. A patched file must match its
recorded patched hash, and `--check-patches` proves that reversing the recorded patch
reproduces the upstream hash. `--restore-from` rebuilds the tree from the exact commit
and reapplies the recorded patches.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def sha256(data):
    return hashlib.sha256(data).hexdigest()


# Variables git treats as selecting one particular repository, as printed by
# `git rev-parse --local-env-vars` (git 2.43). Inherited from a caller (a hook, a linked
# worktree, `git rebase --exec`) they would point the temporary repository at the
# caller's: GIT_COMMON_DIR alone makes `git init` fail in the temporary directory.
GIT_LOCAL_ENV_VARS = frozenset((
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
))


def isolated_git_env():
    """The process environment without any repository-local git variable.

    The fixed list is the floor; the installed git's own list is added so a newer git's
    additions are dropped too. Asking git needs no repository.
    """
    env = {k: v for k, v in os.environ.items() if k.upper() not in GIT_LOCAL_ENV_VARS}
    try:
        names = subprocess.run(["git", "rev-parse", "--local-env-vars"], env=env, check=True,
                               capture_output=True, text=True).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        names = []
    local = GIT_LOCAL_ENV_VARS | {name.upper() for name in names}
    return {k: v for k, v in env.items() if k.upper() not in local}


def apply_patches(files, patches, reverse=False):
    """Apply recorded patches to {path: bytes} in a temporary directory, returning new bytes.

    Inside a repository subdirectory `git apply` silently skips paths it considers outside
    that directory, so patches are only ever applied in an isolated temporary tree. The
    tree is made its own repository root: the system temp directory may itself sit inside
    some other repository (e.g. a stray `git init` in the home directory), which would
    otherwise make `git apply` skip every path without an error. Ambient repository
    selection variables are dropped for the same reason (see isolated_git_env).
    """
    env = isolated_git_env()
    with tempfile.TemporaryDirectory(prefix="aipster-vendor-patch-") as temp:
        init = subprocess.run(["git", "init", "-q", temp], env=env, capture_output=True, text=True)
        if init.returncode:
            raise SystemExit("Could not create the temporary patch repository: " + init.stderr.strip())
        for path, data in files.items():
            (Path(temp) / path).parent.mkdir(parents=True, exist_ok=True)
            (Path(temp) / path).write_bytes(data)
        for patch in (reversed(patches) if reverse else patches):
            subprocess.run(["git", "-c", "core.autocrlf=false", "apply", "--whitespace=nowarn",
                            *(["-R"] if reverse else []), str(ROOT / patch["path"])],
                           cwd=temp, check=True, env=env)
        return {path: (Path(temp) / path).read_bytes() for path in files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore-from", type=Path)
    parser.add_argument("--check-patches", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "provenance.json").read_text())
    vendor = ROOT / "vendor/eif"
    patches = manifest.get("local_patches", [])
    for patch in patches:
        if sha256((ROOT / patch["path"]).read_bytes()) != patch["sha256"]:
            raise SystemExit("Hash mismatch: " + patch["path"])
        if patch["applies_to_commit"] != manifest["commit"]:
            raise SystemExit("Patch base differs from pinned commit: " + patch["path"])
    patched = {path for patch in patches for path in patch["files"]}
    if not patched <= {item["path"] for item in manifest["files"]}:
        raise SystemExit("Patch names a file outside the allowlist: " + str(sorted(patched)))
    upstream = {}
    for item in manifest["files"]:
        path = item["path"]
        if (path in patched) != ("upstream_sha256" in item):
            raise SystemExit("Patch record inconsistent for " + path)
        target = vendor / path
        if not target.resolve().is_relative_to(vendor.resolve()):
            raise SystemExit("Path outside vendor directory")
        if args.restore_from:
            data = subprocess.check_output([
                "git", "-C", str(args.restore_from), "show", manifest["commit"] + ":" + path
            ])
            if sha256(data) != item.get("upstream_sha256", item["sha256"]):
                raise SystemExit("Upstream hash mismatch: " + path)
            upstream[path] = data
    if args.restore_from:
        restored = upstream | apply_patches({p: upstream[p] for p in patched}, patches)
        expected = {item["path"]: item["sha256"] for item in manifest["files"]}
        for path, data in restored.items():
            if sha256(data) != expected[path]:
                raise SystemExit("Restored bytes do not match the recorded hash; nothing written: " + path)
        for path, data in restored.items():
            (vendor / path).parent.mkdir(parents=True, exist_ok=True)
            (vendor / path).write_bytes(data)
    if args.check_patches:
        reverted = apply_patches({p: (vendor / p).read_bytes() for p in patched}, patches, reverse=True)
        for item in manifest["files"]:
            if item["path"] in patched and sha256(reverted[item["path"]]) != item["upstream_sha256"]:
                raise SystemExit("Reversed patch does not reproduce upstream: " + item["path"])
    for item in manifest["files"]:
        if sha256((vendor / item["path"]).read_bytes()) != item["sha256"]:
            raise SystemExit("Hash mismatch: " + item["path"])
    allowed = {item["path"] for item in manifest["files"]} | {"LICENSE", "NOTICE"}
    actual = {p.relative_to(vendor).as_posix() for p in vendor.rglob("*") if p.is_file()}
    if actual != allowed:
        raise SystemExit("Unexpected/missing vendor files: " + str(sorted(actual ^ allowed)))
    print(f"Verified {len(manifest['files'])} files against {manifest['commit']}: "
          f"{len(manifest['files']) - len(patched)} upstream-identical, {len(patched)} locally patched"
          + (" (patches reverse to upstream)" if args.check_patches else ""))


if __name__ == "__main__":
    main()
