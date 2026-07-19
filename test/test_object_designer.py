import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import object_designer


class ObjectDesignerTests(unittest.TestCase):
    def base_level(self):
        grid = [list("." * 15) for _ in range(12)]
        grid[9][2] = "S"
        grid[9][12] = "E"
        # A tall wall at x=7 with a four-block upper platform. Column x=6 is
        # a meaningful ladder prospect from the reachable floor to that landing.
        for row in range(5, 10):
            grid[row][7] = "X"
        for col in range(7, 11):
            grid[5][col] = "X"
        grid[10] = list("X" * 15)
        grid[11] = list("X" * 15)
        return "\n".join(",".join(row) for row in grid)

    def test_applies_only_safe_data_template(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog_path = Path(directory) / "objects.json"
            log_path = Path(directory) / "object_log.jsonl"
            catalog_path.write_text(json.dumps([{
                "id": "ladder", "symbol": "L", "name": "Ladder",
                "description": "climb", "behavior": "ladder", "color": "#c9955d",
                "params": {"climb_speed": 3.2}, "source_round": 0,
                "design_reason": "vertical routes",
            }]))
            proposal = {
                "name": "Mega Spring", "description": "adds vertical launches",
                "behavior": "bounce", "color": "not-a-color",
                "params": {"launch_speed": 999}, "design_reason": "more movement variety",
            }
            with mock.patch.object(object_designer, "CATALOG_PATH", catalog_path), \
                 mock.patch.object(object_designer, "DESIGN_LOG_PATH", log_path):
                added = object_designer.apply_proposals([proposal], 3)
                catalog = object_designer.load_catalog()

            self.assertEqual(len(added), 1)
            self.assertEqual(added[0]["behavior"], "bounce")
            self.assertEqual(added[0]["params"]["launch_speed"], 16.0)
            self.assertEqual(added[0]["color"], "#6fc3ff")
            self.assertEqual(len(catalog), 2)
            self.assertTrue(log_path.exists())

    def test_rejects_duplicate_or_unsupported_behavior(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog_path = Path(directory) / "objects.json"
            catalog_path.write_text(json.dumps([{
                "id": "ladder", "symbol": "L", "behavior": "ladder"
            }]))
            proposals = [
                {"name": "Another ladder", "behavior": "ladder"},
                {"name": "Scripted portal", "behavior": "portal"},
            ]
            with mock.patch.object(object_designer, "CATALOG_PATH", catalog_path):
                self.assertEqual(object_designer.apply_proposals(proposals, 2), [])

    def test_applies_safe_ladder_patch_to_existing_game_file(self):
        candidates, candidate_errors = object_designer.ladder_candidates(self.base_level())
        self.assertEqual(candidate_errors, [])
        candidate = next(item for item in candidates if item["x"] == 6)
        patch = {"placements": [candidate["id"]]}
        edited, errors = object_designer._apply_placement_patch(
            self.base_level(), patch, candidates
        )
        self.assertEqual(errors, [])
        rows = [row.split(",") for row in edited.strip().splitlines()]
        self.assertEqual(rows[candidate["top_y"]][6], "L")
        self.assertEqual(rows[9][6], "L")
        self.assertEqual(candidate["priority"], "critical_access")
        self.assertGreaterEqual(candidate["wall_height"], 3)
        self.assertGreaterEqual(candidate["upper_platform_width"], 3)

    def test_tiny_decorative_platform_is_not_a_ladder_candidate(self):
        grid = [list("." * 15) for _ in range(12)]
        grid[9][2] = "S"; grid[9][12] = "E"
        grid[8][7] = "X"  # one unsupported-looking decorative block
        grid[10] = list("X" * 15); grid[11] = list("X" * 15)
        level = "\n".join(",".join(row) for row in grid)
        candidates, errors = object_designer.ladder_candidates(level)
        self.assertEqual(errors, [])
        self.assertEqual(candidates, [])

    def test_inaccessible_wide_platform_is_ranked_by_connectivity_gain(self):
        grid = [list("." * 20) for _ in range(14)]
        grid[11][2] = "S"; grid[11][17] = "E"
        for col in range(8, 14):
            grid[6][col] = "X"
        grid[12] = list("X" * 20); grid[13] = list("X" * 20)
        level = "\n".join(",".join(row) for row in grid)

        candidates, errors = object_designer.ladder_candidates(level)

        self.assertEqual(errors, [])
        self.assertTrue(candidates)
        candidate = candidates[0]
        self.assertEqual(candidate["priority"], "critical_access")
        self.assertEqual(candidate["candidate_type"], "elevated_platform_access")
        self.assertGreaterEqual(candidate["unlocked_standable_cells"], 3)
        self.assertGreater(candidate["inaccessible_coverage"], 0)
        self.assertNotEqual(candidate["unlocked_region_id"], "none")

    def test_rejects_isolated_or_destructive_object_placement(self):
        candidates, _ = object_designer.ladder_candidates(self.base_level())
        malformed = {"placements": [123]}
        _, errors = object_designer._apply_placement_patch(self.base_level(), malformed)
        self.assertIn("ID string", " ".join(errors))
        invented = {"placements": ["L999"]}
        _, errors = object_designer._apply_placement_patch(
            self.base_level(), invented, candidates
        )
        self.assertIn("unknown candidate IDs", " ".join(errors))

    def test_validation_failures_become_deduplicated_resolvable_lessons(self):
        with tempfile.TemporaryDirectory() as directory:
            lessons_path = Path(directory) / "object_lessons.json"
            with mock.patch.object(object_designer, "LESSONS_PATH", lessons_path):
                first_ids = object_designer.record_validation_failures(
                    ["ladders[3] needs X directly below bottom_y"], 7, 1
                )
                second_ids = object_designer.record_validation_failures(
                    ["ladders[19] needs X directly below bottom_y"], 8, 2
                )
                object_designer.mark_failures_resolved(set(second_ids), 8)
                lessons = object_designer.load_lessons()
        self.assertEqual(first_ids, second_ids)
        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["failure_type"], "missing_ground")
        self.assertEqual(lessons[0]["seen_count"], 2)
        self.assertEqual(lessons[0]["evidence_rounds"], [7, 8])
        self.assertEqual(lessons[0]["successful_corrections"], 1)

    @mock.patch("agent.object_designer.llm.complete_json")
    def test_independent_pass_reads_grid_and_returns_only_coordinates(self, complete_json):
        complete_json.return_value = {"placements": []}
        with tempfile.TemporaryDirectory() as directory:
            lessons_path = Path(directory) / "object_lessons.json"
            lessons_path.write_text(json.dumps([
                {
                    "id": "OL-001", "lesson": "Use ladders to clarify vertical routes.",
                    "conditions": ["multi-level scenes"], "outcome": "clear traversal",
                    "confidence": 0.8, "seen_count": 1, "evidence_rounds": [3],
                    "role": "object_designer",
                },
                {
                    "id": "OL-002", "lesson": "Avoid evenly spaced decorative ladders.",
                    "conditions": ["all scenes"], "outcome": "intentional pacing",
                    "confidence": 0.7, "seen_count": 1, "evidence_rounds": [2],
                    "role": "object_designer",
                },
            ]))
            with mock.patch.object(object_designer, "LESSONS_PATH", lessons_path):
                edited, result = object_designer.place_objects(
                    self.base_level(), {"width": 15, "height": 12,
                                        "solids": [{"x": 0, "y": 10, "width": 15, "height": 2}]},
                    {"diagnosis": "route needs clarity"},
                    {"players": [{"comment": "I got lost"}]}, 4,
                )
                lessons = object_designer.load_lessons()
        self.assertEqual(edited.strip(), self.base_level().strip())
        self.assertEqual(result, {"placements": []})
        self.assertEqual(lessons[0]["role"], "object_designer")
        prompt = complete_json.call_args.args[1]
        system = complete_json.call_args.args[0]
        self.assertNotIn("GENERATED GAME FILE", prompt)
        self.assertNotIn(self.base_level(), prompt)
        self.assertIn("GENERATED JSON LEVEL PLAN", prompt)
        self.assertIn('"width":15', prompt)
        self.assertIn("POTENTIAL PREVALIDATED LADDER AREAS", prompt)
        self.assertIn("Use ladders to clarify", system)
        self.assertIn("Avoid evenly spaced decorative ladders", system)
        self.assertIn("COMPLETE PERSISTENT", system)
        self.assertNotIn('"reason":', object_designer.PLACEMENT_SYSTEM)
        self.assertNotIn('"lessons":', object_designer.PLACEMENT_SYSTEM)


if __name__ == "__main__":
    unittest.main()
