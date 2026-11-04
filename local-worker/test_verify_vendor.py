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


@unittest.skipUnless(shutil.which("git"), "git is required by verify_vendor.py")
class TempDirInsideRepositoryTests(unittest.TestCase):
    def run_verify(self, temp_dir, *args):
        env = dict(os.environ)
        for name in ("TMPDIR", "TEMP", "TMP"):
            env[name] = str(temp_dir)
        # Isolate from any ambient repository selection of the caller.
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES"):
            env.pop(name, None)
        return subprocess.run([sys.executable, str(VERIFY), *args], cwd=str(ROOT), env=env,
                              capture_output=True, text=True, timeout=120)

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


if __name__ == "__main__":
    unittest.main()
