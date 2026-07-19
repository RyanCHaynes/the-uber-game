import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import enemy_designer, llm, object_designer, pipeline, store


class PipelineEnemyIntegrationTests(unittest.TestCase):
    def level(self):
        grid = [list("." * 15) for _ in range(12)]
        grid[9][2] = "S"; grid[9][12] = "E"
        grid[10] = list("X" * 15); grid[11] = list("X" * 15)
        return "\n".join(",".join(row) for row in grid) + "\n"

    def test_enemy_patch_is_saved_before_updated_roster_reaches_designer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            levels = root / "levels"; levels.mkdir()
            rounds = root / "rounds"; round_dir = rounds / "round_002"; round_dir.mkdir(parents=True)
            level_path = levels / "level_001.csv"; level_path.write_text(self.level())
            feedback = {"round": 2, "level": "level_001", "players": [{
                "rating": 3, "completed": False, "deaths": 1,
                "fall_locations": [], "time_seconds": 20,
                "enemies_killed": 1, "hits_taken": 2, "comment": "enemy was fast",
            }]}
            (round_dir / "feedback.json").write_text(json.dumps(feedback))
            patch = {"note": "slow wasp", "ops": [["mul", "wasp.attack.speed", 0.8]]}
            observed = {}

            def analyze(*_args):
                return {"diagnosis": "combat needs tuning", "lessons": [],
                        "fun_score": 3, "save_level": False}

            def design(_level, _analysis, _lessons, _library, **kwargs):
                observed["roster_text"] = kwargs["roster_text"]
                return self.level(), {"width": 15, "height": 12}

            with mock.patch.object(pipeline, "DATA_DIR", root), \
                 mock.patch.object(pipeline, "LEVELS_DIR", levels), \
                 mock.patch.object(pipeline, "ROUNDS_DIR", rounds), \
                 mock.patch.object(pipeline, "_get_brains", return_value=(analyze, design, "llm")), \
                 mock.patch.object(store, "record_feedback_outcome"), \
                 mock.patch.object(store, "lessons_as_text", return_value=""), \
                 mock.patch.object(store, "should_consolidate", return_value=(False, "")), \
                 mock.patch.object(store, "relevant_lessons", return_value=[]), \
                 mock.patch.object(store, "format_lessons", return_value=""), \
                 mock.patch.object(store, "library_summary", return_value=""), \
                 mock.patch.object(store, "record_applications"), \
                 mock.patch.object(object_designer, "propose", return_value=[]), \
                 mock.patch.object(object_designer, "apply_proposals", return_value=[]), \
                 mock.patch.object(object_designer, "roster_summary", return_value="objects"), \
                 mock.patch.object(object_designer, "place_objects",
                                   side_effect=lambda level, *_args: (level, {"placements": []})), \
                 mock.patch.object(enemy_designer, "adapt_and_write", return_value=patch) as adapt, \
                 mock.patch.object(enemy_designer, "roster_summary", return_value="1: Tuned Wasp"), \
                 mock.patch.object(llm, "reset_cycle_usage"), \
                 mock.patch.object(llm, "cycle_usage", return_value={"used": 10, "calls": 1, "budget": 60000}):
                result = pipeline.run_cycle(2, level_path)

            artifact = json.loads((round_dir / "enemy_design.json").read_text())

        self.assertEqual(result.name, "level_002.csv")
        self.assertEqual(artifact, patch)
        self.assertEqual(observed["roster_text"], "1: Tuned Wasp")
        adapt.assert_called_once()


if __name__ == "__main__":
    unittest.main()
