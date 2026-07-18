import assert from 'node:assert/strict';
import test from 'node:test';

import { GameRoom } from '../server/game-room.js';
import { castleLevel } from '../shared/levels/castle.js';
import { prepareLevel, validateLevel } from '../shared/level.js';

function copyLevel(overrides = {}) {
  return {
    ...castleLevel,
    tiles: [...castleLevel.tiles],
    ...overrides,
  };
}

test('preserved castle is a bounded immutable level revision', () => {
  const level = prepareLevel(copyLevel());
  assert.equal(level.width, 48);
  assert.equal(level.height, 22);
  assert.equal(level.tiles.length, 1056);
  assert.ok(Object.isFrozen(level));
  assert.ok(Object.isFrozen(level.tiles));
});

test('validator rejects unknown tiles and the old missing-player-one bug', () => {
  const unknown = copyLevel();
  unknown.tiles[0] = 99;
  assert.equal(validateLevel(unknown).ok, false);

  const missingPlayerOne = copyLevel();
  missingPlayerOne.tiles = missingPlayerOne.tiles.map((tile) => tile === 5 ? 0 : tile);
  const result = validateLevel(missingPlayerOne);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /player-one spawn/);
});

test('validator rejects duplicate spawns and unbounded grids', () => {
  const duplicate = copyLevel();
  duplicate.tiles[0] = 5;
  assert.equal(validateLevel(duplicate).ok, false);

  const oversized = copyLevel({ width: 129 });
  assert.equal(validateLevel(oversized).ok, false);
});

test('failed candidate publication leaves the authoritative revision unchanged', () => {
  const room = new GameRoom({ level: copyLevel() });
  const invalid = copyLevel({ revision: 'bad' });
  invalid.tiles.fill(0);
  assert.throws(() => room.setLevel(invalid), /Invalid level/);
  assert.equal(room.level.revision, 'castle-v1');
});
