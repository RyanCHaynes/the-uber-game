import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { GameRoom } from '../server/game-room.js';
import { castleLevel } from '../shared/levels/castle.js';
import { activeLevelCandidate } from '../shared/levels/index.js';
import { prepareLevel, validateLevel } from '../shared/level.js';

function copyLevel(overrides = {}) {
  return {
    ...activeLevelCandidate,
    tiles: [...activeLevelCandidate.tiles],
    spawnTiles: activeLevelCandidate.spawnTiles.map((spawn) => ({ ...spawn })),
    ...overrides,
  };
}

test('preserved castle is a bounded immutable level revision', () => {
  const level = prepareLevel(copyLevel());
  assert.equal(level.width, 48);
  assert.equal(level.height, 22);
  assert.equal(level.tiles.length, 1056);
  assert.equal(level.spawnTiles.length, 10);
  assert.equal(
    createHash('sha256').update(JSON.stringify(castleLevel.tiles)).digest('hex'),
    '303869a17e44e26e65a400fb34f69042cc76f73b01a3886b95e5d126da05225e',
  );
  assert.ok(Object.isFrozen(level));
  assert.ok(Object.isFrozen(level.tiles));
  assert.ok(Object.isFrozen(level.spawnTiles));
  assert.ok(level.spawnTiles.every((spawn) => Object.isFrozen(spawn)));
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

test('validator rejects duplicate markers, unsafe player spawns, and unbounded grids', () => {
  const duplicateMarker = copyLevel();
  duplicateMarker.tiles[0] = 5;
  assert.equal(validateLevel(duplicateMarker).ok, false);

  const duplicateSpawn = copyLevel();
  duplicateSpawn.spawnTiles[2] = { ...duplicateSpawn.spawnTiles[0] };
  assert.equal(validateLevel(duplicateSpawn).ok, false);

  const unsupportedSpawn = copyLevel();
  unsupportedSpawn.spawnTiles[2] = { x: 4, y: 18 };
  assert.equal(validateLevel(unsupportedSpawn).ok, false);

  const clippedSpawn = copyLevel();
  clippedSpawn.spawnTiles[2] = { x: 30, y: 19 };
  assert.equal(validateLevel(clippedSpawn).ok, false);

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
