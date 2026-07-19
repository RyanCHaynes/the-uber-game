import unittest
from unittest import mock

from agent import csv_level, designer


class LevelPlanCompilerTests(unittest.TestCase):
    def valid_plan(self):
        return {
            "width": 150,
            "height": 12,
            "spawn": {"x": 2, "y": 9},
            "exit": {"x": 147, "y": 9},
            "solids": [{"x": 0, "y": 10, "width": 150, "height": 2}],
            "enemies": [
                {"type": 1, "x": 20, "y": 9},
                {"type": 2, "x": 100, "y": 9},
            ],
            "objects": [],
        }

    def test_compiles_valid_plan_to_reachable_grid(self):
        compact = designer._compile_plan(self.valid_plan())
        rows = compact.splitlines()
        self.assertEqual(len(rows), 12)
        self.assertTrue(all(len(row) == 150 for row in rows))
        self.assertEqual(rows[9][2], "S")
        self.assertEqual(rows[9][147], "E")
        self.assertEqual(
            csv_level.validate_text(compact, min_cols=designer.MIN_DESIGN_COLS), []
        )

    def test_rejects_rectangle_outside_bounds(self):
        plan = self.valid_plan()
        plan["solids"] = [{"x": 149, "y": 10, "width": 2, "height": 2}]
        with self.assertRaisesRegex(ValueError, "outside the level bounds"):
            designer._compile_plan(plan)

    def test_rejects_entity_overlapping_solid(self):
        plan = self.valid_plan()
        plan["spawn"] = {"x": 2, "y": 10}
        with self.assertRaisesRegex(ValueError, "spawn overlaps"):
            designer._compile_plan(plan)

    def test_rejects_non_integer_dimensions(self):
        plan = self.valid_plan()
        plan["width"] = "150"
        with self.assertRaisesRegex(ValueError, "width must be an integer"):
            designer._compile_plan(plan)

    def test_repairs_bounds_entity_count_and_embedded_spawn(self):
        plan = self.valid_plan()
        plan["width"] = 150
        plan["height"] = 30
        plan["spawn"] = {"x": 5, "y": 27}
        plan["exit"] = {"x": 140, "y": 27}
        plan["solids"] = [
            {"x": 0, "y": 28, "width": 150, "height": 2},
            {"x": 0, "y": 24, "width": 15, "height": 4},
            {"x": 140, "y": 24, "width": 30, "height": 2},
        ]
        plan["enemies"] = [
            {"type": 1, "x": 20 + i * 3, "y": 27} for i in range(25)
        ]

        repaired, corrections = designer._repair_plan(plan)
        compact = designer._compile_plan(repaired)

        self.assertEqual(len(repaired["enemies"]), csv_level.MAX_ENEMIES)
        self.assertEqual(repaired["solids"][2]["width"], 10)
        self.assertNotEqual(repaired["spawn"], plan["spawn"])
        self.assertIn("clipped solids[2]", " ".join(corrections))
        self.assertIn("trimmed enemies", " ".join(corrections))
        self.assertEqual(
            csv_level.validate_text(compact, min_cols=designer.MIN_DESIGN_COLS), []
        )

    def test_repairs_unreachable_level_with_minimum_change_connector(self):
        plan = self.valid_plan()
        plan["solids"] = [
            {"x": 0, "y": 10, "width": 10, "height": 2},
            {"x": 20, "y": 10, "width": 130, "height": 2},
        ]
        candidate = designer._compile_plan(plan)
        self.assertIn(
            "exit is not reachable from spawn",
            " ".join(csv_level.validate_text(
                candidate, min_cols=designer.MIN_DESIGN_COLS
            )),
        )

        repaired, corrections = designer._repair_reachability(candidate)

        self.assertEqual(
            csv_level.validate_text(repaired, min_cols=designer.MIN_DESIGN_COLS), []
        )
        self.assertIn("minimum-change connector", corrections[0])

    def test_compiles_catalog_object(self):
        plan = self.valid_plan()
        plan["objects"] = [{"symbol": "L", "x": 40, "y": 8}]
        compact = designer._compile_plan(plan)
        self.assertEqual(compact.splitlines()[8][40], "L")

    def test_ladder_route_is_reachable(self):
        grid = [list("." * 15) for _ in range(12)]
        grid[9][4] = "S"
        grid[10] = list("X" * 15)
        for row in range(4, 10):
            grid[row][7] = "L"
        for col in range(8, 15):
            grid[5][col] = "X"
        grid[4][10] = "E"
        self.assertEqual(csv_level.validate(grid), [])
        for row in range(4, 9):
            grid[row][7] = "."
        self.assertIn("exit is not reachable", " ".join(csv_level.validate(grid)))

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
        self.assertEqual(len(grid[0]), 150)
        self.assertIn(",", result)
        complete_json.assert_called_once()
        self.assertEqual(complete_json.call_args.kwargs["max_tokens"], 6000)

    @mock.patch("agent.designer.llm.complete_json")
    def test_retry_includes_repaired_previous_plan_and_validation_error(self, complete_json):
        invalid = self.valid_plan()
        invalid["solids"] = [{"x": 0, "y": 0, "width": 150, "height": 12}]
        valid = self.valid_plan()
        complete_json.side_effect = [invalid, valid]
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

        designer.design(current, {}, "", "")

        self.assertEqual(complete_json.call_count, 2)
        retry_prompt = complete_json.call_args_list[1].args[1]
        self.assertIn("PREVIOUS INVALID PLAN", retry_prompt)
        self.assertIn('"width":150', retry_prompt)
        self.assertIn("cannot place spawn", retry_prompt)


if __name__ == "__main__":
    unittest.main()
