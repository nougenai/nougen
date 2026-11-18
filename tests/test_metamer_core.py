import hashlib
import tempfile
import unittest
from pathlib import Path
from metamer.core import Contract, Engine, STAGES


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.e = Engine(Path(self.tmp.name) / "events.sqlite")
        self.contract = Contract("Reduce latency", ("Tenant isolation", "Correct results"))
        self.e.start("run1", self.contract)

    def tearDown(self):
        self.e.close()
        self.tmp.cleanup()

    def proof(self):
        return {"passed": True, "artifact_sha256": hashlib.sha256(b"artifact").hexdigest(),
                "checks": ["unit", "isolation"]}

    def test_full_sequence_and_terminal(self):
        for expected in STAGES[1:]:
            self.assertEqual(self.e.advance("run1", self.proof()), expected)
        self.assertEqual(self.e.advance("run1", self.proof()), "verified")
        self.assertTrue(self.e.verify_chain("run1"))
        with self.assertRaises(ValueError):
            self.e.advance("run1", self.proof())

    def test_fail_closed_action(self):
        self.e.request_action("run1", "design")
        for action in ("implement", "release", "recover", "unknown"):
            with self.assertRaises(PermissionError):
                self.e.request_action("run1", action, {"approved": True})

    def test_bad_evidence(self):
        for evidence in ({}, {"passed": False}, {"passed": True, "artifact_sha256": "broken", "checks": ["unit"]},
                         {"passed": True, "artifact_sha256": "a" * 64, "checks": []}):
            with self.assertRaises(ValueError):
                self.e.advance("run1", evidence)
        self.assertEqual(self.e.state("run1")["stage"], "deep_grip")

    def test_tamper_detection(self):
        self.e.advance("run1", self.proof())
        self.e.db.execute("UPDATE events SET payload=? WHERE kind='stage_passed'", ('{"changed":true}',))
        self.assertFalse(self.e.verify_chain("run1"))

    def test_restart_state(self):
        self.e.advance("run1", self.proof())
        self.e.close()
        self.e = Engine(Path(self.tmp.name) / "events.sqlite")
        self.assertEqual(self.e.state("run1")["stage"], "leverage")
        self.assertTrue(self.e.verify_chain("run1"))

    def test_blocked(self):
        self.e.fail("run1", "Missing verified data", blocked=True)
        self.assertEqual(self.e.state("run1")["status"], "blocked")
        self.assertTrue(self.e.verify_chain("run1"))

    def test_contract_validation(self):
        with self.assertRaises(ValueError):
            self.e.start("run2", Contract("", ("invariant",)))
        with self.assertRaises(ValueError):
            self.e.start("run3", Contract("target", (), max_iterations=0))


if __name__ == "__main__":
    unittest.main()
