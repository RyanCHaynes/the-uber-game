import json
import unittest
from pathlib import Path

from agent import enemy_designer
from agent.entity import generator, schema

ROSTER = json.loads((Path(enemy_designer.__file__).parent / "data" / "enemies.json").read_text())


class FlyingEnemyTests(unittest.TestCase):
    def test_roster_flyers_have_awareness_range(self):
        by_id = {e.get("id"): e for e in ROSTER}
        for eid in ("mech_moth", "sky_sentinel", "pit_rescue_drone", "drone_carrier"):
            motion = by_id[eid]["root"]["motion"]
            self.assertIsInstance(motion.get("range"), (int, float),
                                  f"{eid} root motion needs an awareness range")
        # the carrier's chasing minions are bounded too
        self.assertIsInstance(
            by_id["drone_carrier"]["defs"]["drone"]["motion"].get("range"), (int, float))

    def test_shipped_entityspecs_pass_stricter_motion_validation(self):
        for enemy in ROSTER:
            if enemy_designer.is_entity_spec(enemy):
                self.assertEqual(schema.validate(enemy).errors, [], enemy.get("id"))

    def test_schema_rejects_non_numeric_motion_range(self):
        spec = {"v": 1, "id": "x", "name": "X", "kind": "enemy",
                "root": {"id": "r", "body": {"shape": "box"}, "health": {"max": 3},
                         "motion": {"type": "chase", "range": "far"}}}
        self.assertTrue(any("range" in err for err in schema.validate(spec).errors))

    def test_sanitizer_clamps_oversized_range(self):
        enemy = {"v": 1, "id": "y", "kind": "enemy",
                 "root": {"id": "r", "motion": {"type": "hover", "range": 999}}}
        enemy_designer._sanitize_enemy(enemy)
        self.assertEqual(enemy["root"]["motion"]["range"], 30)

    def test_mock_generated_flyer_has_awareness_range(self):
        spec = generator._mock_spec("a flying drone that chases the player")
        self.assertIn("range", spec["root"]["motion"])


if __name__ == "__main__":
    unittest.main()
