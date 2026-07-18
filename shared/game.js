export const TILE = Object.freeze({
  EMPTY: 0,
  STONE: 1,
  BRICK: 2,
  PLATFORM: 3,
  WINDOW: 4,
  PLAYER_ONE_SPAWN: 5,
  PLAYER_TWO_SPAWN: 6,
  COIN_SPAWN: 7,
});

export const PLAYER_COLORS = Object.freeze([
  '#4fd1c5', '#ef6d86', '#ffd152', '#8fa8ff', '#bd8cff',
  '#ff9a62', '#79d878', '#f58bd5', '#5ec8ff', '#d0d56b',
]);

export const GAME = Object.freeze({
  minPlayers: 2,
  maxPlayers: PLAYER_COLORS.length,
  windowWidth: 1280,
  windowHeight: 720,
  arenaTop: 92,
  playerHalfWidth: 18,
  playerHalfHeight: 24,
  coinRadius: 14,
  playerSpeed: 235,
  gravity: 1450,
  jumpSpeed: 570,
  maximumFallSpeed: 760,
  winningScore: 5,
  tickRate: 50,
  snapshotRate: 20,
  gameOverSeconds: 4,
});

export const CLIENT_MESSAGE = Object.freeze({
  HELLO: 'hello',
  READY: 'ready',
  INPUT: 'input',
});

export const SERVER_MESSAGE = Object.freeze({
  WELCOME: 'welcome',
  LOBBY: 'lobby',
  LEVEL: 'level',
  GAME_START: 'gameStart',
  SNAPSHOT: 'snapshot',
  NOTICE: 'notice',
});
