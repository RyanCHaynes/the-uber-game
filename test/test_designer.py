import unittest
from unittest import mock

from agent import csv_level, designer


class LevelPlanCompilerTests(unittest.TestCase):
    def valid_plan(self):
        return {
            "width": 250,
            "height": 12,
            "spawn": {"x": 2, "y": 9},
            "exit": {"x": 247, "y": 9},
            "solids": [{"x": 0, "y": 10, "width": 250, "height": 2}],
            "enemies": [
                {"type": 1, "x": 20, "y": 9},
                {"type": 2, "x": 100, "y": 9},
            ],
        }

    def test_compiles_valid_plan_to_reachable_grid(self):
        compact = designer._compile_plan(self.valid_plan())
        rows = compact.splitlines()
        self.assertEqual(len(rows), 12)
        self.assertTrue(all(len(row) == 250 for row in rows))
        self.assertEqual(rows[9][2], "S")
        self.assertEqual(rows[9][247], "E")
        self.assertEqual(
            csv_level.validate_text(compact, min_cols=designer.MIN_DESIGN_COLS), []
        )

    def test_rejects_rectangle_outside_bounds(self):
        plan = self.valid_plan()
        plan["solids"] = [{"x": 249, "y": 10, "width": 2, "height": 2}]
        with self.assertRaisesRegex(ValueError, "outside the level bounds"):
            designer._compile_plan(plan)

    def test_rejects_entity_overlapping_solid(self):
        plan = self.valid_plan()
        plan["spawn"] = {"x": 2, "y": 10}
        with self.assertRaisesRegex(ValueError, "spawn overlaps"):
            designer._compile_plan(plan)

    def test_rejects_non_integer_dimensions(self):
        plan = self.valid_plan()
        plan["width"] = "250"
        with self.assertRaisesRegex(ValueError, "width must be an integer"):
            designer._compile_plan(plan)

    @mock.patch("agent.designer.llm.complete_json")
    def test_design_compiles_model_plan_to_pipeline_csv(self, complete_json):
        complete_json.return_value = self.valid_plan()
        current = "\n".join([
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,.,.,.,.",
            ".,S,.,E,.",
            "X,X,X,X,X",
            "X,X,X,X,X",
        ])
        result = designer.design(current, {}, "", "")
        grid, errors = csv_level.parse(result)

        self.assertEqual(errors, [])
        self.assertEqual(len(grid), 12)
        self.assertEqual(len(grid[0]), 250)
        self.assertIn(",", result)
        complete_json.assert_called_once()
        self.assertEqual(complete_json.call_args.kwargs["max_tokens"], 6000)


if __name__ == "__main__":
    unittest.main()
