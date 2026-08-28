#!/usr/bin/env python3
"""tibo 双窗口状态机测试。"""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest

TEST_DIR = tempfile.TemporaryDirectory()
MODULE_PATH = Path(__file__).with_name("quota-window-watcher.py")
os.environ["TIBO_QUOTA_WORK_DIR"] = TEST_DIR.name
os.environ["TIBO_QUOTA_SOCKET"] = str(Path(TEST_DIR.name) / "control.sock")
if "resource" not in sys.modules:
    sys.modules["resource"] = types.SimpleNamespace(
        RUSAGE_SELF=0,
        RUSAGE_CHILDREN=1,
        getrusage=lambda _: types.SimpleNamespace(ru_utime=0.0, ru_stime=0.0),
    )
SPEC = importlib.util.spec_from_file_location("quota_window_watcher", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
WATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCHER)


class StateMachineTest(unittest.TestCase):
    def test_extracts_both_windows(self):
        value = WATCHER.extract_windows({"rateLimits": {
            "primary": {"usedPercent": 1, "windowDurationMins": 300, "resetsAt": 100},
            "secondary": {"usedPercent": 2, "windowDurationMins": 10080, "resetsAt": 200},
        }})
        self.assertEqual(100, value["fiveHour"]["resetsAt"])
        self.assertEqual(200, value["weekly"]["resetsAt"])

    def test_resets_at_jitter_does_not_create_new_generation(self):
        state = WATCHER.default_state()
        weekly = state["weekly"]
        weekly.update({
            "generation": 4, "lastAttemptGeneration": 4, "lastUsedPercent": 0.0,
            "lastObservedResetsAt": 1000, "zeroCount": 2, "status": "failed",
        })
        action = WATCHER.observe_weekly(state, {"usedPercent": 0.0, "resetsAt": 1001}, 500)
        self.assertEqual("observe_empty", action)
        self.assertEqual(4, weekly["generation"])

    def test_crossed_real_boundary_creates_one_generation(self):
        state = WATCHER.default_state()
        weekly = state["weekly"]
        weekly.update({
            "generation": 2, "lastAttemptGeneration": 2, "lastUsedPercent": 0.0,
            "lastObservedResetsAt": 1000, "zeroCount": 9,
        })
        action = WATCHER.observe_weekly(state, {"usedPercent": 0.0, "resetsAt": 2000}, 1001)
        self.assertEqual("confirm_empty", action)
        self.assertEqual(3, weekly["generation"])
        action = WATCHER.observe_weekly(state, {"usedPercent": 0.0, "resetsAt": 2001}, 1002)
        self.assertEqual("anchor", action)

    def test_temporary_zero_before_confirmed_reset_does_not_advance(self):
        state = WATCHER.default_state()
        weekly = state["weekly"]
        weekly.update({
            "generation": 8, "lastAttemptGeneration": 8, "lastUsedPercent": 2.0,
            "lastObservedResetsAt": 2000, "lastConfirmedResetsAt": 2000,
            "zeroCount": 0, "status": "verified",
        })
        action = WATCHER.observe_weekly(state, {"usedPercent": 0.0, "resetsAt": 2001}, 1500)
        self.assertEqual("confirm_empty", action)
        action = WATCHER.observe_weekly(state, {"usedPercent": 0.0, "resetsAt": 2002}, 1505)
        self.assertEqual("observe_empty", action)
        self.assertEqual(8, weekly["generation"])

    def test_migration_blocks_duplicate_current_generation(self):
        state = WATCHER.migrate_state({
            "version": 2, "status": "failed", "windowGeneration": 4,
            "lastAttemptAt": 123, "lastObservedResetsAt": 1000, "lastUsedPercent": 0,
        })
        self.assertEqual(4, state["weekly"]["lastAttemptGeneration"])

    def test_verified_window_keeps_original_anchor_source(self):
        state = WATCHER.default_state()
        weekly = state["weekly"]
        weekly.update({
            "status": "verified", "anchorSource": "script", "generation": 3,
            "lastConfirmedResetsAt": 1000, "lastObservedResetsAt": 1000,
            "lastUsedPercent": 2.0, "stableCount": 2,
        })
        WATCHER.observe_weekly(state, {"usedPercent": 3.0, "resetsAt": 1001}, 900)
        self.assertEqual("script", weekly["anchorSource"])

    def test_slot_validation(self):
        self.assertTrue(WATCHER.valid_slot_key("2026-08-26@06:01"))
        self.assertFalse(WATCHER.valid_slot_key("2026-08-29@06:01"))
        self.assertFalse(WATCHER.valid_slot_key("2026-08-26@12:00"))


if __name__ == "__main__":
    unittest.main()
