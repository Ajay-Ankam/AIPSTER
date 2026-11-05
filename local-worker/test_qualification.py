"""Focused qualification assignment tests (meta-qual lane). Fixtures only."""
import unittest

import qualification as qual


def assignment(**over):
    base = {
        "runId": "qrun_1",
        "nodeId": "res1",
        "profileDigest": "a" * 64,
        "catalogVersion": "qual-catalog-v1",
        "catalogId": "completion-smoke-v1",
        "leaseId": "qlease_1",
        "deadlineAt": "2026-11-05T06:00:00.000Z",
        "runtimeAllowlist": ["ganglion"],
        "maxTokens": 32,
    }
    base.update(over)
    return base


class AssignmentTest(unittest.TestCase):
    def test_happy_path(self):
        self.assertEqual(qual.validate_assignment(assignment())["catalogId"],
                         "completion-smoke-v1")

    def test_rejects_unknown_field_and_bad_catalog(self):
        bad = assignment()
        bad["prompt"] = "evil"
        with self.assertRaises(qual.QualificationError):
            qual.validate_assignment(bad)
        with self.assertRaises(qual.QualificationError):
            qual.validate_assignment(assignment(catalogId="gpu-burn-v9"))
        with self.assertRaises(qual.QualificationError):
            qual.validate_assignment(assignment(maxTokens=64))
        with self.assertRaises(qual.QualificationError):
            qual.validate_assignment(assignment(profileDigest="zz"))

    def test_readiness_refusals(self):
        with self.assertRaises(qual.QualificationError):
            qual.check_readiness(runtime_id="cuda", model_listed=True,
                                 mem_total_bytes=8 << 30)
        with self.assertRaises(qual.QualificationError):
            qual.check_readiness(runtime_id="ganglion", model_listed=False,
                                 mem_total_bytes=8 << 30)
        with self.assertRaises(qual.QualificationError):
            qual.check_readiness(runtime_id="ganglion", model_listed=True,
                                 mem_total_bytes=128)
        self.assertIsNone(qual.check_readiness(
            runtime_id="llama-server", model_listed=True,
            mem_total_bytes=8 << 30))


if __name__ == "__main__":
    unittest.main()
