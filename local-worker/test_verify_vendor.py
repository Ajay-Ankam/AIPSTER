"""verify_vendor.py must not depend on where the system temp directory lives.

Regression: `git apply` run inside an enclosing repository silently skips
paths it considers outside that repository's working tree. When %TEMP% /
$TMPDIR sat inside any git repository (e.g. a stray `git init` in the home
directory), `--check-patches` applied nothing and failed with "Reversed patch
does not reproduce upstream". Stdlib only; needs `git` on PATH like the tool.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERIFY = ROOT / "verify_vendor.py"

# `git rev-parse --local-env-vars` (git 2.43) plus GIT_CEILING_DIRECTORIES: the
# test harness starts every run from a clean slate, then sets only what a case needs.
AMBIENT_GIT_VARS = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES",
)


def run_verify(temp_dir, *args, extra_env=None):
    env = dict(os.environ)
    for name in ("TMPDIR", "TEMP", "TMP"):
        env[name] = str(temp_dir)
    # Isolate from any ambient repository selection of the caller.
    for name in AMBIENT_GIT_VARS:
        env.pop(name, None)
    env.update(extra_env or {})
    return subprocess.run([sys.executable, str(VERIFY), *args], cwd=str(ROOT), env=env,
                          capture_output=True, text=True, timeout=120)


@unittest.skipUnless(shutil.which("git"), "git is required by verify_vendor.py")
class TempDirInsideRepositoryTests(unittest.TestCase):
    def run_verify(self, temp_dir, *args, extra_env=None):
        return run_verify(temp_dir, *args, extra_env=extra_env)

    def make_enclosing_repo(self):
        outer = tempfile.TemporaryDirectory(prefix="aipster-outer-repo-")
        self.addCleanup(outer.cleanup)
        subprocess.run(["git", "init", "-q", outer.name], check=True, capture_output=True)
        inner = Path(outer.name) / "nested" / "tmp"
        inner.mkdir(parents=True)
        return inner

    def test_check_patches_passes_when_temp_dir_is_inside_a_repository(self):
        result = self.run_verify(self.make_enclosing_repo(), "--check-patches")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("patches reverse to upstream", result.stdout)

    def test_check_patches_still_passes_with_a_plain_temp_dir(self):
        plain = tempfile.TemporaryDirectory(prefix="aipster-plain-tmp-")
        self.addCleanup(plain.cleanup)
        result = self.run_verify(plain.name, "--check-patches")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_enclosing_repository_is_left_untouched(self):
        inner = self.make_enclosing_repo()
        outer = inner.parent.parent
        self.run_verify(inner, "--check-patches")
        status = subprocess.run(["git", "-C", str(outer), "status", "--porcelain"],
                                capture_output=True, text=True, check=True)
        self.assertEqual(status.stdout.strip(), "", "verify must not stage or leave files in the outer repo")


def snapshot(directory):
    """Every file under `directory` with its bytes, so any write, add or delete shows up."""
    return {p.relative_to(directory).as_posix(): p.read_bytes()
            for p in Path(directory).rglob("*") if p.is_file()}


@unittest.skipUnless(shutil.which("git"), "git is required by verify_vendor.py")
class CallerRepositoryEnvironmentTests(unittest.TestCase):
    """Regression for r4471424955: repository-selection variables exported by the caller
    (a hook, a linked worktree, `git rebase --exec`) must not reach the temporary
    repository. Before the fix GIT_COMMON_DIR survived the filter, so `git init` in the
    temporary directory failed with "<temp>/.git/refs/heads: No such file or directory"."""

    def make_caller_repo(self):
        caller = tempfile.TemporaryDirectory(prefix="aipster-caller-repo-")
        self.addCleanup(caller.cleanup)
        git = ["git", "-C", caller.name, "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run(["git", "init", "-q", caller.name], check=True, capture_output=True)
        (Path(caller.name) / "tracked.txt").write_text("caller\n")
        subprocess.run([*git, "add", "tracked.txt"], check=True, capture_output=True)
        subprocess.run([*git, "commit", "-q", "-m", "caller"], check=True, capture_output=True)
        return Path(caller.name)

    def plain_temp(self):
        plain = tempfile.TemporaryDirectory(prefix="aipster-plain-tmp-")
        self.addCleanup(plain.cleanup)
        return plain.name

    def assert_isolated(self, caller, extra_env):
        before = snapshot(caller)
        result = run_verify(self.plain_temp(), "--check-patches", extra_env=extra_env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("patches reverse to upstream", result.stdout)
        self.assertEqual(snapshot(caller), before, "the caller's repository must be left byte-identical")

    def test_check_patches_ignores_caller_git_common_dir(self):
        caller = self.make_caller_repo()
        self.assert_isolated(caller, {"GIT_COMMON_DIR": str(caller / ".git")})

    def test_check_patches_ignores_every_caller_repository_variable(self):
        caller = self.make_caller_repo()
        git_dir = caller / ".git"
        self.assert_isolated(caller, {
            "GIT_DIR": str(git_dir), "GIT_COMMON_DIR": str(git_dir), "GIT_WORK_TREE": str(caller),
            "GIT_INDEX_FILE": str(git_dir / "index"), "GIT_OBJECT_DIRECTORY": str(git_dir / "objects"),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(git_dir / "objects"),
            "GIT_PREFIX": "nested/", "GIT_IMPLICIT_WORK_TREE": "0",
        })


if __name__ == "__main__":
    unittest.main()
