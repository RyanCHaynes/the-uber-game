import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import store


class StructuredMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patches = mock.patch.multiple(
            store,
            STORE_DIR=root,
            LESSONS_PATH=root / "lessons.json",
            MEMORY_META_PATH=root / "memory_meta.json",
            CONSOLIDATION_LOG_PATH=root / "consolidation_log.jsonl",
        )
        self.patches.start()

    def tearDown(self):
        self.patches.stop()
        self.temp.cleanup()

    def test_load_migrates_legacy_lessons_without_losing_evidence(self):
        store.STORE_DIR.mkdir(parents=True, exist_ok=True)
        store.LESSONS_PATH.write_text(json.dumps([{
            "lesson": "Wide pits after spawn frustrate players.",
            "source_round": 2,
            "seen_count": 3,
        }]))

        lesson = store.load_lessons()[0]

        self.assertEqual(lesson["id"], "lesson_0001")
        self.assertEqual(lesson["category"], "fairness")
        self.assertEqual(lesson["evidence_rounds"], [2])
        self.assertEqual(lesson["seen_count"], 3)

    def test_add_lessons_preserves_structure_and_reinforces_exact_match(self):
        incoming = {
            "lesson": "Turrets need a clear line of fire.",
            "category": "enemy_placement",
            "conditions": ["stationary turret"],
            "outcome": "the enemy remains relevant",
            "confidence": 0.8,
        }
        store.add_lessons([incoming], 4)
        store.add_lessons([incoming], 6)

        lessons = store.load_lessons()

        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["seen_count"], 2)
        self.assertEqual(lessons[0]["evidence_rounds"], [4, 6])
        self.assertEqual(lessons[0]["category"], "enemy_placement")

    def test_retrieval_prefers_lessons_relevant_to_current_problem(self):
        store.add_lessons([
            {"lesson": "Turrets need line of fire to the player path.", "category": "combat"},
            {"lesson": "Long levels need varied terrain rhythms.", "category": "terrain"},
        ], 1)

        result = store.relevant_lessons("stationary turret cannot shoot player", limit=1)

        self.assertIn("Turrets", result[0]["lesson"])

    def test_application_is_linked_to_later_feedback_outcome(self):
        lesson = store.add_lessons([
            {"lesson": "Use varied terrain to sustain engagement."}
        ], 2)[0]

        store.record_applications([lesson["id"]], design_round=2)
        store.record_feedback_outcome(2, {
            "rating": 4, "completed": True, "deaths": 1,
        })
        updated = store.load_lessons()[0]

        self.assertEqual(updated["applied_count"], 1)
        self.assertEqual(updated["successful_applications"], 1)
        self.assertEqual(updated["applications"][0]["rating"], 4)

    def test_meaningful_overlap_triggers_consolidation(self):
        store.add_lessons([
            {"lesson": "Turrets on wide platforms cannot hit players below."},
            {"lesson": "Wide platforms make turrets unable to hit players below."},
            {"lesson": "Levels need varied terrain."},
            {"lesson": "Pits should be readable."},
            {"lesson": "Enemy waves need pacing."},
        ], 3)
        store.MEMORY_META_PATH.write_text(json.dumps({"lesson_count_after": 5}))

        due, reason = store.should_consolidate(0)

        self.assertTrue(due)
        self.assertEqual(reason, "likely overlapping lessons")

    def test_consolidation_compacts_but_retains_source_history(self):
        lessons = store.add_lessons([
            {"lesson": "Turrets need clear sight lines.", "category": "combat", "confidence": 0.7},
            {"lesson": "Blocked turret sight lines make enemies harmless.", "category": "combat", "confidence": 0.8},
        ], 4)
        groups = [{
            "lesson_ids": [lessons[0]["id"], lessons[1]["id"]],
            "canonical_lesson": "Turrets need clear sight lines to remain threatening.",
            "category": "combat",
            "conditions": ["stationary turret"],
            "outcome": "combat remains relevant",
            "confidence": 0.9,
        }]

        report = store.consolidate_lessons(groups, "test overlap")
        compacted = store.load_lessons()

        self.assertEqual(report["before_count"], 2)
        self.assertEqual(report["after_count"], 1)
        self.assertEqual(compacted[0]["seen_count"], 2)
        self.assertEqual(len(compacted[0]["merged_from"]), 1)
        self.assertTrue(store.CONSOLIDATION_LOG_PATH.exists())
        audit = json.loads(store.CONSOLIDATION_LOG_PATH.read_text().splitlines()[0])
        self.assertEqual(len(audit["merges"][0]["source_entries"]), 2)


if __name__ == "__main__":
    unittest.main()
