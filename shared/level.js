import { GAME, TILE } from './game.js';

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

  const { revision, tileSize, width, height, tiles, spawnTiles } = candidate;
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

  if (!Array.isArray(spawnTiles) || spawnTiles.length !== GAME.maxPlayers) {
    errors.push(`Level must define exactly ${GAME.maxPlayers} player spawn positions.`);
  } else {
    const seen = new Set();
    const solidTiles = new Set([TILE.STONE, TILE.BRICK, TILE.PLATFORM]);
    for (let slot = 0; slot < spawnTiles.length; slot += 1) {
      const spawn = spawnTiles[slot];
      if (!spawn || !Number.isInteger(spawn.x) || !Number.isInteger(spawn.y)) {
        errors.push(`Player spawn ${slot + 1} must use integer tile coordinates.`);
        continue;
      }
      const key = `${spawn.x},${spawn.y}`;
      if (seen.has(key)) errors.push(`Player spawn ${slot + 1} overlaps another spawn.`);
      seen.add(key);
      for (let previous = 0; previous < slot; previous += 1) {
        const other = spawnTiles[previous];
        if (!other || !Number.isInteger(other.x) || !Number.isInteger(other.y)) continue;
        if (Math.abs(spawn.x - other.x) * tileSize < GAME.playerHalfWidth * 2 &&
            Math.abs(spawn.y - other.y) * tileSize < GAME.playerHalfHeight * 2) {
          errors.push(`Player spawn ${slot + 1} overlaps another player's body.`);
        }
      }
      if (spawn.x < 1 || spawn.x >= width - 1 || spawn.y < 0 || spawn.y >= height - 1) {
        errors.push(`Player spawn ${slot + 1} is outside the safe level bounds.`);
        continue;
      }
      const tile = tiles[spawn.y * width + spawn.x];
      const below = tiles[(spawn.y + 1) * width + spawn.x];
      if (solidTiles.has(tile) || tile === TILE.COIN_SPAWN || !solidTiles.has(below)) {
        errors.push(`Player spawn ${slot + 1} must be empty and stand on solid ground.`);
        continue;
      }
      const centerX = (spawn.x + 0.5) * tileSize;
      const centerY = (spawn.y + 1) * tileSize - GAME.playerHalfHeight;
      const left = Math.floor((centerX - GAME.playerHalfWidth + 1) / tileSize);
      const right = Math.floor((centerX + GAME.playerHalfWidth - 1) / tileSize);
      const top = Math.floor((centerY - GAME.playerHalfHeight + 1) / tileSize);
      const bottom = Math.floor((centerY + GAME.playerHalfHeight - 1) / tileSize);
      let intersectsSolid = false;
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          if (solidTiles.has(tiles[y * width + x])) intersectsSolid = true;
        }
      }
      if (intersectsSolid) errors.push(`Player spawn ${slot + 1} does not clear nearby solid tiles.`);
    }
    const firstTile = spawnTiles[0] && tiles[spawnTiles[0].y * width + spawnTiles[0].x];
    const secondTile = spawnTiles[1] && tiles[spawnTiles[1].y * width + spawnTiles[1].x];
    if (firstTile !== TILE.PLAYER_ONE_SPAWN || secondTile !== TILE.PLAYER_TWO_SPAWN) {
      errors.push('The first two spawn positions must preserve the original player markers.');
    }
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
    spawnTiles: Object.freeze(candidate.spawnTiles.map(({ x, y }) => Object.freeze({ x, y }))),
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

export function playerSpawnPositions(level) {
  return level.spawnTiles.map(({ x, y }) => ({
    x: (x + 0.5) * level.tileSize,
    y: (y + 0.5) * level.tileSize,
  }));
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
