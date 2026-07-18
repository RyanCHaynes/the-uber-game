import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_RUSH_LEVEL_SCHEMA = 'token-rush-level/v1';
export const TOKEN_RUSH_TILE_SIZE = 32;
export const TOKEN_RUSH_GRID = Object.freeze({ w: 48, h: 22 });
export const TOKEN_RUSH_LEVEL_MAX_BYTES = 32 * 1024;
export const TOKEN_RUSH_ENEMY_TYPES = Object.freeze(['crawler', 'guard', 'warden']);
export const TOKEN_RUSH_ACTOR_BODIES = Object.freeze({
  player: Object.freeze({ halfWidth: 18, halfHeight: 24 }),
  enemy: Object.freeze({ halfWidth: 22, halfHeight: 28 }),
});

const LEVEL_KEYS = Object.freeze(['schema', 'id', 'size', 'spawn', 'exit', 'solids', 'enemies', 'tokens']);
const ENEMY_STATS = Object.freeze({
  crawler: Object.freeze({ name: 'Crypt Crawler', health: 1, speed: 78 }),
  guard: Object.freeze({ name: 'Crypt Guard', health: 2, speed: 52 }),
  warden: Object.freeze({ name: 'Crypt Warden', health: 3, speed: 58 }),
});

export class TokenRushLevelError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TokenRushLevelError';
    this.code = code;
  }
}

function reject(code) {
  throw new TokenRushLevelError(code);
}

function plainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    reject(code);
  }
  return value;
}

function exactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject(code);
  return value;
}

function point(value, code) {
  plainObject(value, code);
  exactKeys(value, ['x', 'y'], code);
  return {
    x: integer(value.x, 0, TOKEN_RUSH_GRID.w - 1, code),
    y: integer(value.y, 0, TOKEN_RUSH_GRID.h - 3, code),
  };
}

function cellIndex(x, y) {
  return y * TOKEN_RUSH_GRID.w + x;
}

function actorPosition(position, halfHeight) {
  return {
    x: (position.x + 0.5) * TOKEN_RUSH_TILE_SIZE,
    y: (position.y + 2) * TOKEN_RUSH_TILE_SIZE - halfHeight,
  };
}

function actorOverlapsSolid(position, body, solid) {
  const center = actorPosition(position, body.halfHeight);
  const left = solid.x * TOKEN_RUSH_TILE_SIZE;
  const top = solid.y * TOKEN_RUSH_TILE_SIZE;
  const right = (solid.x + solid.w) * TOKEN_RUSH_TILE_SIZE;
  const bottom = (solid.y + solid.h) * TOKEN_RUSH_TILE_SIZE;
  return center.x + body.halfWidth > left &&
    center.x - body.halfWidth < right &&
    center.y + body.halfHeight > top &&
    center.y - body.halfHeight < bottom;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateTokenRushLevel(document) {
  plainObject(document, 'LEVEL_OBJECT');
  exactKeys(document, LEVEL_KEYS, 'LEVEL_KEYS');
  if (document.schema !== TOKEN_RUSH_LEVEL_SCHEMA) reject('LEVEL_SCHEMA');
  if (typeof document.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(document.id)) reject('LEVEL_ID');

  plainObject(document.size, 'LEVEL_SIZE');
  exactKeys(document.size, ['w', 'h'], 'LEVEL_SIZE');
  if (document.size.w !== TOKEN_RUSH_GRID.w || document.size.h !== TOKEN_RUSH_GRID.h) reject('LEVEL_SIZE');

  if (!Array.isArray(document.solids) || document.solids.length < 1 || document.solids.length > 64) reject('SOLID_COUNT');
  const occupied = new Uint8Array(TOKEN_RUSH_GRID.w * TOKEN_RUSH_GRID.h);
  const solids = document.solids.map((value) => {
    plainObject(value, 'SOLID_SHAPE');
    exactKeys(value, ['x', 'y', 'w', 'h'], 'SOLID_SHAPE');
    const solid = {
      x: integer(value.x, 0, TOKEN_RUSH_GRID.w - 1, 'SOLID_BOUNDS'),
      y: integer(value.y, 0, TOKEN_RUSH_GRID.h - 1, 'SOLID_BOUNDS'),
      w: integer(value.w, 1, TOKEN_RUSH_GRID.w, 'SOLID_BOUNDS'),
      h: integer(value.h, 1, TOKEN_RUSH_GRID.h, 'SOLID_BOUNDS'),
    };
    if (solid.x + solid.w > TOKEN_RUSH_GRID.w || solid.y + solid.h > TOKEN_RUSH_GRID.h) reject('SOLID_BOUNDS');
    for (let y = solid.y; y < solid.y + solid.h; y += 1) {
      for (let x = solid.x; x < solid.x + solid.w; x += 1) {
        const index = cellIndex(x, y);
        if (occupied[index]) reject('SOLID_OVERLAP');
        occupied[index] = 1;
      }
    }
    return solid;
  });

  const assertSupported = (position, code) => {
    if (occupied[cellIndex(position.x, position.y)] || occupied[cellIndex(position.x, position.y + 1)]) reject(code);
    if (!occupied[cellIndex(position.x, position.y + 2)]) reject(code);
  };
  const assertActorSupported = (position, body, supportCode, clearanceCode) => {
    assertSupported(position, supportCode);
    if (solids.some((solid) => actorOverlapsSolid(position, body, solid))) reject(clearanceCode);
  };
  const spawn = point(document.spawn, 'SPAWN_BOUNDS');
  const exit = point(document.exit, 'EXIT_BOUNDS');
  assertActorSupported(spawn, TOKEN_RUSH_ACTOR_BODIES.player, 'SPAWN_SUPPORT', 'SPAWN_SOLID_CLEARANCE');
  assertSupported(exit, 'EXIT_SUPPORT');
  if (spawn.x === exit.x && spawn.y === exit.y) reject('SPAWN_EXIT_OVERLAP');
  const occupiedEntityCells = new Set([`${spawn.x},${spawn.y}`, `${exit.x},${exit.y}`]);

  if (!Array.isArray(document.enemies) || document.enemies.length > 8) reject('ENEMY_COUNT');
  const enemyCells = new Set();
  const enemies = document.enemies.map((value) => {
    plainObject(value, 'ENEMY_SHAPE');
    exactKeys(value, ['type', 'x', 'y'], 'ENEMY_SHAPE');
    if (!TOKEN_RUSH_ENEMY_TYPES.includes(value.type)) reject('ENEMY_TYPE');
    const position = point({ x: value.x, y: value.y }, 'ENEMY_BOUNDS');
    assertActorSupported(position, TOKEN_RUSH_ACTOR_BODIES.enemy, 'ENEMY_SUPPORT', 'ENEMY_SOLID_CLEARANCE');
    const key = `${position.x},${position.y}`;
    if (enemyCells.has(key)) reject('ENEMY_OVERLAP');
    if (occupiedEntityCells.has(key)) reject('ENTITY_OVERLAP');
    enemyCells.add(key);
    occupiedEntityCells.add(key);
    return { type: value.type, ...position };
  });

  if (!Array.isArray(document.tokens) || document.tokens.length < 1 || document.tokens.length > 32) reject('TOKEN_COUNT');
  const tokenCells = new Set();
  const tokens = document.tokens.map((value) => {
    const position = point(value, 'TOKEN_BOUNDS');
    assertSupported(position, 'TOKEN_SUPPORT');
    const key = `${position.x},${position.y}`;
    if (tokenCells.has(key)) reject('TOKEN_OVERLAP');
    if (occupiedEntityCells.has(key)) reject('ENTITY_OVERLAP');
    tokenCells.add(key);
    occupiedEntityCells.add(key);
    return position;
  });

  return deepFreeze({
    schema: TOKEN_RUSH_LEVEL_SCHEMA,
    id: document.id,
    size: { ...TOKEN_RUSH_GRID },
    spawn,
    exit,
    solids,
    enemies,
    tokens,
  });
}

export function compileTokenRushLevel(document) {
  const level = validateTokenRushLevel(document);
  const tiles = Array(TOKEN_RUSH_GRID.w * TOKEN_RUSH_GRID.h).fill(0);
  for (const solid of level.solids) {
    for (let y = solid.y; y < solid.y + solid.h; y += 1) {
      for (let x = solid.x; x < solid.x + solid.w; x += 1) tiles[cellIndex(x, y)] = 1;
    }
  }
  const solids = level.solids.map((solid) => ({
    x: solid.x * TOKEN_RUSH_TILE_SIZE,
    y: solid.y * TOKEN_RUSH_TILE_SIZE,
    width: solid.w * TOKEN_RUSH_TILE_SIZE,
    height: solid.h * TOKEN_RUSH_TILE_SIZE,
  }));
  const fullFloor = level.solids
    .filter((solid) => solid.x === 0 && solid.w === TOKEN_RUSH_GRID.w)
    .sort((left, right) => left.y - right.y)[0];
  if (!fullFloor) reject('FULL_FLOOR_REQUIRED');
  return deepFreeze({
    schema: TOKEN_RUSH_LEVEL_SCHEMA,
    id: level.id,
    revision: `${level.id}@token-rush-level-v1`,
    tileSize: TOKEN_RUSH_TILE_SIZE,
    width: TOKEN_RUSH_GRID.w * TOKEN_RUSH_TILE_SIZE,
    height: TOKEN_RUSH_GRID.h * TOKEN_RUSH_TILE_SIZE,
    floorY: fullFloor.y * TOKEN_RUSH_TILE_SIZE,
    tiles,
    spawn: actorPosition(level.spawn, TOKEN_RUSH_ACTOR_BODIES.player.halfHeight),
    exit: {
      x: level.exit.x * TOKEN_RUSH_TILE_SIZE,
      y: level.exit.y * TOKEN_RUSH_TILE_SIZE,
      width: TOKEN_RUSH_TILE_SIZE,
      height: TOKEN_RUSH_TILE_SIZE * 2,
    },
    solids,
    enemies: level.enemies.map((enemy, index) => ({
      id: `${enemy.type}-${index + 1}`,
      type: enemy.type,
      ...ENEMY_STATS[enemy.type],
      position: actorPosition(enemy, TOKEN_RUSH_ACTOR_BODIES.enemy.halfHeight),
    })),
    tokens: level.tokens.map((token, index) => ({
      id: `token-${index + 1}`,
      x: (token.x + 0.5) * TOKEN_RUSH_TILE_SIZE,
      y: (token.y + 0.5) * TOKEN_RUSH_TILE_SIZE,
    })),
  });
}

export const FALLBACK_TOKEN_RUSH_LEVEL = deepFreeze({
  schema: TOKEN_RUSH_LEVEL_SCHEMA,
  id: 'crypt-fallback',
  size: { w: 48, h: 22 },
  spawn: { x: 2, y: 18 },
  exit: { x: 46, y: 18 },
  solids: [
    { x: 0, y: 20, w: 48, h: 2 },
    { x: 7, y: 17, w: 5, h: 1 },
    { x: 16, y: 15, w: 6, h: 1 },
    { x: 27, y: 18, w: 5, h: 1 },
    { x: 37, y: 16, w: 6, h: 1 },
  ],
  enemies: [
    { type: 'crawler', x: 11, y: 18 },
    { type: 'guard', x: 24, y: 18 },
    { type: 'warden', x: 41, y: 18 },
  ],
  tokens: [
    { x: 9, y: 15 },
    { x: 19, y: 13 },
    { x: 29, y: 16 },
    { x: 40, y: 14 },
  ],
});

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOKEN_RUSH_LEVEL_FILE = path.resolve(moduleDirectory, '../content/token-rush-level.json');

export function loadTokenRushLevelFile(file = DEFAULT_TOKEN_RUSH_LEVEL_FILE) {
  try {
    const details = statSync(file);
    if (!details.isFile() || details.size < 2 || details.size > TOKEN_RUSH_LEVEL_MAX_BYTES) reject('LEVEL_FILE_SIZE');
    const bytes = readFileSync(file);
    if (bytes.length !== details.size) reject('LEVEL_FILE_CHANGED');
    let document;
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      reject('LEVEL_JSON');
    }
    return Object.freeze({ level: compileTokenRushLevel(document), source: 'file', rejectionCode: null });
  } catch (error) {
    const rejectionCode = error instanceof TokenRushLevelError ? error.code : 'LEVEL_FILE_READ';
    return Object.freeze({
      level: compileTokenRushLevel(FALLBACK_TOKEN_RUSH_LEVEL),
      source: 'fallback',
      rejectionCode,
    });
  }
}
