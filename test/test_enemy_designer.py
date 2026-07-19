import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent import enemy_designer


class EnemyDesignerTests(unittest.TestCase):
    def roster(self):
        return json.loads(enemy_designer.ROSTER_PATH.read_text())

    def test_shipped_roster_is_valid(self):
        self.assertEqual(enemy_designer.validate_roster(self.roster()), [])

    def test_patch_uses_stable_enemy_and_part_ids_without_mutating_input(self):
        roster = self.roster()
        original_speed = roster[2]["attack"]["speed"]
        original_body_hp = roster[2]["parts"][0]["hp"]
        patched, errors = enemy_designer.apply_patch(roster, {
            "note": "make stingers easier to dodge and the body tougher",
            "ops": [
                ["mul", "wasp.attack.speed", 0.8],
                ["add", "wasp.parts.body.hp", 5],
            ],
        })

        self.assertEqual(errors, [])
        self.assertEqual(roster[2]["attack"]["speed"], original_speed)
        self.assertEqual(patched[2]["attack"]["speed"], original_speed * 0.8)
        self.assertEqual(patched[2]["parts"][0]["hp"], original_body_hp + 5)

    def test_invalid_patch_rolls_back_to_unchanged_roster(self):
        roster = self.roster()
        patched, errors = enemy_designer.apply_patch(roster, {
            "ops": [["set", "wasp.parts.missing.hp", 99]],
        })
        self.assertTrue(errors)
        self.assertIs(patched, roster)
        self.assertEqual(patched, self.roster())

    def test_entityspec_roster_entry_passes_schema_and_dry_run(self):
        spec = next(item for item in self.roster()
                    if enemy_designer.is_entity_spec(item))
        self.assertEqual(spec["kind"], "boss")
        self.assertEqual(enemy_designer.dry_run_spec(spec), [])

    def test_entityspec_patch_resolves_stable_node_id(self):
        roster = self.roster()
        patched, errors = enemy_designer.apply_patch(roster, {
            "note": "make the core slightly less durable",
            "ops": [["mul", "iron_moth.entity.moth_core.health.max", 0.9]],
        })
        self.assertEqual(errors, [])
        boss = next(item for item in patched if item.get("id") == "iron_moth")
        self.assertEqual(boss["root"]["health"]["max"], 90)

    def test_entityspec_dry_run_rejects_inert_undamageable_root(self):
        spec = {"v": 1, "id": "prop", "name": "Prop", "kind": "enemy",
                "root": {"id": "prop_root", "visual": {"shape": "box"},
                         "body": {"shape": "box"}}}
        errors = enemy_designer.dry_run_spec(spec)
        self.assertTrue(any("damageable" in error for error in errors))
        self.assertTrue(any("cannot move" in error for error in errors))

    def test_adapt_and_write_backs_up_and_logs_valid_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            roster_path = root / "enemies.json"
            last_good = root / "store" / "enemies_last_good.json"
            design_log = root / "store" / "enemy_design_log.jsonl"
            original = self.roster()
            roster_path.write_text(json.dumps(original))
            patch = {
                "note": "slow the wasp projectile",
                "ops": [["mul", "wasp.attack.speed", 0.8]],
            }
            feedback = {"players": [{"hits_taken": 3, "deaths": 0,
                                      "enemies_killed": 1, "comment": ""}]}
            with mock.patch.object(enemy_designer, "ROSTER_PATH", roster_path), \
                 mock.patch.object(enemy_designer, "LAST_GOOD_PATH", last_good), \
                 mock.patch.object(enemy_designer, "DESIGN_LOG_PATH", design_log), \
                 mock.patch.object(enemy_designer, "adapt", return_value=patch):
                result = enemy_designer.adapt_and_write({}, feedback, 8)

            updated = json.loads(roster_path.read_text())
            backup = json.loads(last_good.read_text())
            logged = json.loads(design_log.read_text().strip())
        self.assertEqual(result, patch)
        self.assertEqual(backup, original)
        self.assertEqual(updated[2]["attack"]["speed"], 3.6)
        self.assertEqual(logged["source_round"], 8)
        self.assertEqual(logged["patch"], patch)

    @mock.patch("agent.enemy_designer.llm.complete_json")
    def test_no_combat_signal_skips_llm_and_write(self, complete_json):
        feedback = {"players": [{"hits_taken": 0, "deaths": 0,
                                  "enemies_killed": 0, "comment": "nice jumps"}]}
        with mock.patch.object(enemy_designer, "_write_roster") as write_roster:
            result = enemy_designer.adapt_and_write({}, feedback, 9)
        self.assertIsNone(result)
        complete_json.assert_not_called()
        write_roster.assert_not_called()


if __name__ == "__main__":
    unittest.main()
