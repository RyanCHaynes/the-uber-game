import { castleLevel } from './castle.js';
import { castleSpawnTiles } from './castle-spawns.js';

export const activeLevelCandidate = Object.freeze({
  ...castleLevel,
  spawnTiles: castleSpawnTiles,
});
