"""Bounded read-after-write settle for private storage (Windows only).

Regression lane for the concurrent first-pair race: after
SetNamedSecurityInfoW reports success, the re-read can still observe the
descriptor write as not yet visible (owner visible before DACL
protection, or the fully pre-write state). protect_path must settle
boundedly on exactly those transient signatures instead of failing on
the first re-read. Anything else, or anything persistent, still fails
closed on the same strict check.
"""
import os
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import private_storage_win32 as win32
from private_storage_win32 import PrivateStorageError, protect_path

FOREIGN_SID = "S-1-5-21-9-9-9-9999"
USER_SID = "S-1-5-21-1-1-1-1001"
ADMIN_SID = "S-1-5-32-544"


@contextmanager
def _flaky_final_assert(failures):
    """Fail the post-write assert `failures` times, then run the real one."""
    real_assert = win32._assert_private
    calls = {"n": 0}

    def flaky(owner, descriptor, dacl, user, default_owner, directory):
        calls["n"] += 1
        if calls["n"] <= len(failures):
            raise failures[calls["n"] - 1]
        return real_assert(owner, descriptor, dacl, user, default_owner, directory)

    with patch.object(win32, "_assert_private", side_effect=flaky) as mocked:
        yield mocked, calls


@unittest.skipUnless(os.name == "nt", "Windows private-storage ACL semantics")
class PostWriteSettleTests(unittest.TestCase):
    def test_transient_signatures(self):
        inherited = PrivateStorageError(0, "inherited-acl", USER_SID, ADMIN_SID, USER_SID)
        self.assertTrue(win32._transient_after_write(inherited, USER_SID, ADMIN_SID))
        foreign_acl = PrivateStorageError(0, "inherited-acl", USER_SID, ADMIN_SID, FOREIGN_SID)
        self.assertFalse(win32._transient_after_write(foreign_acl, USER_SID, ADMIN_SID))
        pre_write = PrivateStorageError(2, "owner-mismatch", USER_SID, ADMIN_SID, ADMIN_SID)
        self.assertTrue(win32._transient_after_write(pre_write, USER_SID, ADMIN_SID))
        foreign_owner = PrivateStorageError(2, "owner-mismatch", USER_SID, ADMIN_SID, FOREIGN_SID)
        self.assertFalse(win32._transient_after_write(foreign_owner, USER_SID, ADMIN_SID))
        # Non-elevated token: no distinct default owner, never a transient.
        same_owner = PrivateStorageError(2, "owner-mismatch", USER_SID, USER_SID, USER_SID)
        self.assertFalse(win32._transient_after_write(same_owner, USER_SID, USER_SID))
        other = PrivateStorageError(0, "null-dacl", USER_SID, ADMIN_SID, USER_SID)
        self.assertFalse(win32._transient_after_write(other, USER_SID, ADMIN_SID))

    def test_post_write_transient_settles_then_passes(self):
        user, default_owner = win32._identity()
        transient = PrivateStorageError(0, "inherited-acl", user, default_owner, user)
        with tempfile.TemporaryDirectory(prefix="settle-write-") as tmp:
            target = Path(tmp) / "data"
            target.mkdir()
            with _flaky_final_assert([transient] * 5) as (mocked, calls):
                self.assertTrue(protect_path(target, directory=True, new=True))
            self.assertEqual(calls["n"], 6)
            self.assertTrue(protect_path(target, directory=True, verify=True))

    def test_post_write_persistent_transient_still_fails(self):
        user, default_owner = win32._identity()
        transient = PrivateStorageError(0, "inherited-acl", user, default_owner, user)
        with tempfile.TemporaryDirectory(prefix="settle-persist-") as tmp:
            target = Path(tmp) / "data"
            target.mkdir()
            start = time.monotonic()
            with _flaky_final_assert([transient] * 10000) as (mocked, calls):
                with self.assertRaises(PrivateStorageError) as ctx:
                    protect_path(target, directory=True, new=True)
            elapsed = time.monotonic() - start
            self.assertEqual(ctx.exception.reason, "inherited-acl")
            self.assertGreater(calls["n"], 3)
            self.assertLess(elapsed, win32.WRITE_SETTLE_SEC + 5)

    def test_post_write_foreign_state_fails_immediately(self):
        user, default_owner = win32._identity()
        foreign = PrivateStorageError(0, "foreign-or-incomplete-allow", user, default_owner, user)
        with tempfile.TemporaryDirectory(prefix="settle-foreign-") as tmp:
            target = Path(tmp) / "data"
            target.mkdir()
            with _flaky_final_assert([foreign]) as (mocked, calls):
                with self.assertRaises(PrivateStorageError) as ctx:
                    protect_path(target, directory=True, new=True)
            self.assertEqual(ctx.exception.reason, "foreign-or-incomplete-allow")
            self.assertEqual(calls["n"], 1)


if __name__ == "__main__":
    unittest.main()
