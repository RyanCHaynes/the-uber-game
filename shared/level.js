import { TILE } from './game.js';

export const LEVEL_LIMITS = Object.freeze({
  minWidth: 8,
  maxWidth: 128,
  minHeight: 8,
  maxHeight: 64,
  maxTiles: 8192,
  maxCoins: 128,
});

const allowedTiles = new Set(Object.values(TILE));

export function validateLevel(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['Level must be an object.'] };
  }

  const { revision, tileSize, width, height, tiles } = candidate;
  if (typeof revision !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(revision)) {
    errors.push('Revision must be 1-64 safe identifier characters.');
  }
  if (!Number.isInteger(tileSize) || tileSize < 8 || tileSize > 128) {
    errors.push('Tile size must be an integer from 8 to 128.');
  }
  if (!Number.isInteger(width) || width < LEVEL_LIMITS.minWidth || width > LEVEL_LIMITS.maxWidth) {
    errors.push(`Width must be ${LEVEL_LIMITS.minWidth}-${LEVEL_LIMITS.maxWidth}.`);
  }
  if (!Number.isInteger(height) || height < LEVEL_LIMITS.minHeight || height > LEVEL_LIMITS.maxHeight) {
    errors.push(`Height must be ${LEVEL_LIMITS.minHeight}-${LEVEL_LIMITS.maxHeight}.`);
  }

  const expectedTiles = Number.isInteger(width) && Number.isInteger(height) ? width * height : -1;
  if (!Array.isArray(tiles) || tiles.length !== expectedTiles || tiles.length > LEVEL_LIMITS.maxTiles) {
    errors.push('Tiles must exactly match the bounded width x height grid.');
    return { ok: false, errors };
  }

  let playerOneSpawns = 0;
  let playerTwoSpawns = 0;
  let coinSpawns = 0;
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    if (!Number.isInteger(tile) || !allowedTiles.has(tile)) {
      errors.push(`Unknown tile ID at index ${index}.`);
      break;
    }
    if (tile === TILE.PLAYER_ONE_SPAWN) playerOneSpawns += 1;
    if (tile === TILE.PLAYER_TWO_SPAWN) playerTwoSpawns += 1;
    if (tile === TILE.COIN_SPAWN) coinSpawns += 1;
  }

  if (playerOneSpawns !== 1) errors.push('Level must contain exactly one player-one spawn (tile 5).');
  if (playerTwoSpawns !== 1) errors.push('Level must contain exactly one player-two spawn (tile 6).');
  if (coinSpawns < 1 || coinSpawns > LEVEL_LIMITS.maxCoins) {
    errors.push(`Level must contain 1-${LEVEL_LIMITS.maxCoins} coin spawns (tile 7).`);
  }

  return { ok: errors.length === 0, errors };
}

export function prepareLevel(candidate) {
  const result = validateLevel(candidate);
  if (!result.ok) {
    throw new Error(`Invalid level: ${result.errors.join(' ')}`);
  }
  return Object.freeze({
    revision: candidate.revision,
    tileSize: candidate.tileSize,
    width: candidate.width,
    height: candidate.height,
    tiles: Object.freeze([...candidate.tiles]),
  });
}

export function tileAt(level, tileX, tileY) {
  if (tileX < 0 || tileY < 0 || tileX >= level.width || tileY >= level.height) {
    return TILE.EMPTY;
  }
  return level.tiles[tileY * level.width + tileX];
}

export function isSolid(level, tileX, tileY) {
  if (tileX < 0 || tileX >= level.width || tileY >= level.height) return true;
  if (tileY < 0) return false;
  const tile = tileAt(level, tileX, tileY);
  return tile === TILE.STONE || tile === TILE.BRICK || tile === TILE.PLATFORM;
}

export function positionsFor(level, tileId) {
  const positions = [];
  for (let index = 0; index < level.tiles.length; index += 1) {
    if (level.tiles[index] !== tileId) continue;
    const x = index % level.width;
    const y = Math.floor(index / level.width);
    positions.push({
      x: (x + 0.5) * level.tileSize,
      y: (y + 0.5) * level.tileSize,
    });
  }
  return positions;
}
