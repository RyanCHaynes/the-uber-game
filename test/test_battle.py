import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import battle, enemy_designer


class BattleCycleTests(unittest.TestCase):
    def test_empty_battle_bestiary_skips_generation_without_raising(self):
        """Battle bestiary starts empty; a cycle must degrade gracefully (no arena,
        no crash) rather than raise like it did when the roster was shared."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            battle_roster = root / "battle_enemies.json"
            battle_roster.write_text("[]")
            levels_dir = root / "levels"
            levels_dir.mkdir()
            with mock.patch.object(enemy_designer, "BATTLE_ROSTER_PATH", battle_roster), \
                 mock.patch.object(battle, "LEVELS_DIR", levels_dir), \
                 mock.patch.object(battle, "ROUNDS_DIR", root / "rounds"), \
                 mock.patch.object(battle, "STATE_PATH", root / "battle_state.json"):
                result = battle.run_battle_cycle(1, None)

            self.assertIsNone(result)
            self.assertEqual(list(levels_dir.glob("level_*.csv")), [])  # nothing written
            self.assertFalse((levels_dir / "next_level.ready").exists())

    def test_difficulty_score_rates_a_tougher_enemy_higher(self):
        weak = {"parts": [{"vulnerable": True, "hp": 10}],
                "attack": {"type": "none"}, "contact_damage": 1,
                "movement": {"type": "stationary"}}
        strong = {"parts": [{"vulnerable": True, "hp": 120}],
                  "attack": {"type": "shoot", "damage": 3, "range": 400,
                             "speed": 6, "cooldown_s": 0.8},
                  "contact_damage": 2, "movement": {"type": "flyer", "speed": 80}}
        self.assertGreater(battle.difficulty_score(strong),
                           battle.difficulty_score(weak))


if __name__ == "__main__":
    unittest.main()
