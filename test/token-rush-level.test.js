import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadTokenRushEnemyCatalogFile } from '../shared/token-rush-enemies.js';
import {
  compileTokenRushLevel,
  DEFAULT_TOKEN_RUSH_LEVEL_FILE,
  FALLBACK_TOKEN_RUSH_LEVEL,
  loadTokenRushLevelFile,
  TOKEN_RUSH_ACTOR_BODIES,
  TokenRushLevelError,
  validateTokenRushLevel,
} from '../shared/token-rush-level.js';

const clone = (value) => structuredClone(value);
const enemyCatalog = loadTokenRushEnemyCatalogFile().catalog;

async function authoredLevel() {
  return JSON.parse(await readFile(DEFAULT_TOKEN_RUSH_LEVEL_FILE, 'utf8'));
}

function rejection(document, code) {
  assert.throws(() => validateTokenRushLevel(document, enemyCatalog), (error) =>
    error instanceof TokenRushLevelError && error.code === code);
}

test('authored level and enemy JSON compile spawn, bodies, definitions, and tokens', async () => {
  const document = await authoredLevel();
  const compiled = compileTokenRushLevel(document, enemyCatalog);
  assert.equal(compiled.schema, 'token-rush-level/v1');
  assert.equal(compiled.id, 'crypt-001');
  assert.deepEqual(compiled.spawn, { x: 80, y: 616 });
  assert.deepEqual(compiled.exit, { x: 1472, y: 576, width: 32, height: 64 });
  assert.deepEqual(compiled.solids[1], { x: 224, y: 544, width: 160, height: 32 });
  assert.equal(compiled.tiles.length, 48 * 22);
  assert.equal(compiled.tiles[20 * 48], 1);
  assert.equal(compiled.tiles[17 * 48 + 7], 1);
  assert.equal(compiled.tiles[0], 0);
  assert.deepEqual(compiled.enemies.map(({ type }) => type), ['crawler', 'guard', 'warden']);
  assert.equal(compiled.enemyCatalogRevision, enemyCatalog.revision);
  assert.deepEqual(compiled.tokens[0], { id: 'token-1', x: 304, y: 496 });

  const changed = clone(document);
  changed.id = 'crypt-changed';
  changed.spawn = { x: 3, y: 18 };
  changed.exit = { x: 45, y: 18 };
  changed.enemies = [{ type: 'guard', x: 12, y: 18 }];
  changed.tokens = [{ x: 10, y: 15 }];
  const changedCompiled = compileTokenRushLevel(changed, enemyCatalog);
  assert.equal(changedCompiled.id, 'crypt-changed');
  assert.equal(changedCompiled.spawn.x, 112);
  assert.equal(changedCompiled.exit.x, 1440);
  assert.deepEqual(changedCompiled.enemies.map(({ type }) => type), ['guard']);
  assert.equal(changedCompiled.tokens[0].x, 336);
});

test('contract rejects unknown keys, floats, bounds, overlap, unsupported placements, and enemy types', async () => {
  const original = await authoredLevel();
  const cases = [
    ['LEVEL_KEYS', (value) => { value.script = 'no'; }],
    ['LEVEL_SIZE', (value) => { value.size.w = 49; }],
    ['SOLID_BOUNDS', (value) => { value.solids[1].w = 100; }],
    ['SOLID_OVERLAP', (value) => { value.solids.push({ ...value.solids[1] }); }],
    ['SPAWN_SUPPORT', (value) => { value.spawn.y = 17; }],
    ['EXIT_BOUNDS', (value) => { value.exit.x = 48; }],
    ['ENEMY_TYPE', (value) => { value.enemies[0].type = 'dragon'; }],
    ['ENEMY_BOUNDS', (value) => { value.enemies[0].x = 1.5; }],
    ['TOKEN_SUPPORT', (value) => { value.tokens[0].y = 14; }],
    ['TOKEN_OVERLAP', (value) => { value.tokens.push({ ...value.tokens[0] }); }],
  ];
  for (const [code, mutate] of cases) {
    const value = clone(original);
    mutate(value);
    rejection(value, code);
  }
});

test('contract rejects occupied tiles across spawn, exit, enemy, and token classes', async () => {
  const original = await authoredLevel();
  const cases = [
    (value) => { value.enemies[0] = { type: 'crawler', ...value.spawn }; },
    (value) => { value.enemies[0] = { type: 'crawler', ...value.exit }; },
    (value) => { value.tokens[0] = { ...value.spawn }; },
    (value) => { value.tokens[0] = { x: value.enemies[0].x, y: value.enemies[0].y }; },
    (value) => { value.tokens[0] = { ...value.exit }; },
  ];
  for (const mutate of cases) {
    const value = clone(original);
    mutate(value);
    rejection(value, 'ENTITY_OVERLAP');
  }
});

test('spawn and enemy clearance checks use their exact authoritative runtime AABBs', async () => {
  assert.deepEqual(TOKEN_RUSH_ACTOR_BODIES, {
    player: { halfWidth: 18, halfHeight: 24 },
    enemy: { halfWidth: 22, halfHeight: 28 },
  });
  const original = await authoredLevel();

  const spawnBesideWall = clone(original);
  spawnBesideWall.solids.push({ x: spawnBesideWall.spawn.x + 1, y: spawnBesideWall.spawn.y, w: 1, h: 2 });
  rejection(spawnBesideWall, 'SPAWN_SOLID_CLEARANCE');

  const enemyBesideWall = clone(original);
  enemyBesideWall.solids.push({ x: enemyBesideWall.enemies[0].x + 1, y: enemyBesideWall.enemies[0].y, w: 1, h: 2 });
  rejection(enemyBesideWall, 'ENEMY_SOLID_CLEARANCE');

  const oneTileGap = clone(original);
  oneTileGap.solids.push({ x: oneTileGap.spawn.x + 2, y: oneTileGap.spawn.y, w: 1, h: 2 });
  assert.doesNotThrow(() => validateTokenRushLevel(oneTileGap, enemyCatalog));
});

test('invalid or oversized files fail safely to the immutable known-good level', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'token-rush-level-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = path.join(directory, 'invalid.json');
  await writeFile(invalid, '{"schema":');
  const malformed = loadTokenRushLevelFile(invalid);
  assert.equal(malformed.source, 'fallback');
  assert.equal(malformed.rejectionCode, 'LEVEL_JSON');
  assert.equal(malformed.level.id, FALLBACK_TOKEN_RUSH_LEVEL.id);

  const oversized = path.join(directory, 'oversized.json');
  await writeFile(oversized, ' '.repeat(32 * 1024 + 1));
  const tooLarge = loadTokenRushLevelFile(oversized);
  assert.equal(tooLarge.source, 'fallback');
  assert.equal(tooLarge.rejectionCode, 'LEVEL_FILE_SIZE');
  assert.equal(tooLarge.level.revision, 'crypt-fallback@token-rush-level-v1');

  const missing = loadTokenRushLevelFile(path.join(directory, 'missing.json'));
  assert.equal(missing.source, 'fallback');
  assert.equal(missing.rejectionCode, 'LEVEL_FILE_READ');
});
