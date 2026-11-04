"""Tray engine wording (2026-11-04).

The tray said "Running locally (simulated engine)" for every running worker,
including JJP's real attached llama.cpp runtime (installed 4c69689, /v1/node
simulated=false, real /v1/execute output). Since first-run honesty (4ea019b)
the tray only runs a mock-only selection when AIPSTER_WORKER_MOCK_DEMO=1 is
elected, and the controller passes firstrun.runtime_note() as the RUNNING
detail: "" for a real runtime, "test/demo: ..." for the elected mock. The
label now follows that detail in the menu header, the "started" balloon and
the "Already running" reuse balloon.
"""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.path.insert(0, str(ROOT / "vendor/eif"))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(ROOT))

from aipster_tray import firstrun as first, state  # noqa: E402

MOCK_NOTE = (f"test/demo: mock engine explicitly elected via "
             f"{first.MOCK_DEMO_ENV}=1 (not operational)")


class TrayEngineLabelTests(unittest.TestCase):
    def test_real_runtime_is_not_called_simulated(self):
        for text in (state.header_line(state.RUNNING, ""),
                     state.menu_model(state.RUNNING, detail="")[0]["label"],
                     state.balloon_for("started", state.RUNNING, "")[1],
                     state.balloon_for("reuse", state.RUNNING, "")[1]):
            self.assertNotIn("simulated", text.lower(), text)
            self.assertIn("running locally", text.lower(), text)

    def test_elected_mock_is_still_labelled_simulated(self):
        for text in (state.header_line(state.RUNNING, MOCK_NOTE),
                     state.menu_model(state.RUNNING, detail=MOCK_NOTE)[0]["label"],
                     state.balloon_for("started", state.RUNNING, MOCK_NOTE)[1],
                     state.balloon_for("reuse", state.RUNNING, MOCK_NOTE)[1]):
            self.assertIn("simulated engine, test/demo", text, text)

    def test_runtime_note_drives_the_label(self):
        # The detail the controller actually passes for each selection.
        real = SimpleNamespace()
        with patch.object(first, "classify_runtime_selection",
                          return_value={"status": first.READY, "mock_only": False,
                                        "reason": ""}):
            self.assertEqual(state.state_text(state.RUNNING, first.runtime_note(real)),
                             "Running locally")
        with patch.object(first, "classify_runtime_selection",
                          return_value={"status": "setup", "mock_only": True,
                                        "reason": "mock"}), \
                patch.dict(os.environ, {first.MOCK_DEMO_ENV: "1"}):
            note = first.runtime_note(real)
            self.assertTrue(state.simulated(note), note)
            self.assertTrue(state.state_text(state.RUNNING, note).endswith(
                state.SIMULATED_SUFFIX))

    def test_other_states_ignore_simulated_detail(self):
        self.assertEqual(state.state_text(state.STOPPED, MOCK_NOTE), "Stopped")
        self.assertNotIn("simulated", state.header_line(state.ERROR, "boom").lower())

    def test_wording_stays_honest(self):
        for detail in ("", MOCK_NOTE):
            for text in (state.state_text(state.RUNNING, detail),
                         state.balloon_for("started", state.RUNNING, detail)[1],
                         state.balloon_for("reuse", state.RUNNING, detail)[1]):
                state.check_honest(text)

    def test_controller_passes_detail_to_started_balloon(self):
        source = (WINDOWS.parent / "aipster_tray" / "controller.py").read_text(encoding="utf-8")
        self.assertIn('self.backend.notify("started", st.RUNNING, self.detail)', source)


if __name__ == "__main__":
    unittest.main()
