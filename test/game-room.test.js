import assert from 'node:assert/strict';
import test from 'node:test';

import { GameRoom } from '../server/game-room.js';
import { GAME, PLAYER_COLORS } from '../shared/game.js';
import { activeLevelCandidate } from '../shared/levels/index.js';

class FakeSocket {
  readyState = 1;
  sent = [];
  closed = null;

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function makeRoom(options = {}) {
  const level = {
    ...activeLevelCandidate,
    tiles: [...activeLevelCandidate.tiles],
    spawnTiles: activeLevelCandidate.spawnTiles.map((spawn) => ({ ...spawn })),
  };
  return new GameRoom({ level, random: () => 0, ...options });
}

function join(room, socket, name) {
  room.connect(socket);
  assert.equal(room.receive(socket, { type: 'hello', name }), true);
}

test('two players join, receive slots and level, ready, and start authoritatively', () => {
  const room = makeRoom();
  const first = new FakeSocket();
  const second = new FakeSocket();
  join(room, first, 'Ada');
  join(room, second, 'Grace');

  assert.deepEqual([room.peers.get(first).id, room.peers.get(second).id], [1, 2]);
  assert.ok(first.sent.some((message) => message.type === 'level' && message.level.revision === 'castle-v1'));
  room.receive(first, { type: 'ready', ready: true });
  room.receive(second, { type: 'ready', ready: true });

  assert.equal(room.running, true);
  assert.equal(room.players.size, 2);
  assert.ok(first.sent.some((message) => message.type === 'gameStart'));
  assert.ok(second.sent.some((message) => message.type === 'snapshot'));
});

test('server owns movement, collision, coin scoring, win, and round reset', () => {
  const room = makeRoom();
  const first = new FakeSocket();
  const second = new FakeSocket();
  join(room, first, 'Ada');
  join(room, second, 'Grace');
  room.receive(first, { type: 'ready', ready: true });
  room.receive(second, { type: 'ready', ready: true });

  const firstState = room.players.get(1);
  const startX = firstState.position.x;
  room.receive(first, { type: 'input', input: { up: false, down: false, left: false, right: true } });
  room.tick(0.02);
  assert.ok(firstState.position.x > startX);

  for (let score = 1; score <= 5; score += 1) {
    room.coin = { ...firstState.position };
    room.tick(0.02);
    assert.equal(firstState.score, score);
  }
  assert.equal(room.gameOver, true);
  assert.equal(room.winnerId, 1);

  for (let index = 0; index < 200; index += 1) room.tick(0.02);
  assert.equal(room.running, false);
  assert.equal(room.players.size, 0);
  assert.ok([...room.peers.values()].every((peer) => peer.ready === false));
});

test('disconnect ends a live match and returns the survivor to lobby', () => {
  const room = makeRoom();
  const first = new FakeSocket();
  const second = new FakeSocket();
  join(room, first, 'Ada');
  join(room, second, 'Grace');
  room.receive(first, { type: 'ready', ready: true });
  room.receive(second, { type: 'ready', ready: true });
  room.disconnect(second);
  assert.equal(room.running, false);
  assert.equal(room.connectionCount, 1);
  assert.ok(first.sent.some((message) => message.type === 'notice' && /disconnected/.test(message.text)));
});

test('ten players get unique slots and spawns, all ready, move, score, disconnect, and rejoin', () => {
  const room = makeRoom();
  const sockets = Array.from({ length: GAME.maxPlayers }, () => new FakeSocket());
  sockets.forEach((socket, index) => join(room, socket, `Player ${index + 1}`));

  assert.deepEqual(sockets.map((socket) => room.peers.get(socket).slot), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(PLAYER_COLORS.length, GAME.maxPlayers);
  assert.equal(new Set(PLAYER_COLORS).size, GAME.maxPlayers);
  sockets.slice(0, -1).forEach((socket) => room.receive(socket, { type: 'ready', ready: true }));
  assert.equal(room.running, false);
  room.receive(sockets.at(-1), { type: 'ready', ready: true });

  assert.equal(room.running, true);
  assert.equal(room.players.size, GAME.maxPlayers);
  assert.equal(new Set([...room.players.values()].map((player) => `${player.position.x},${player.position.y}`)).size, GAME.maxPlayers);

  const tenthState = room.players.get(room.peers.get(sockets.at(-1)).id);
  const startX = tenthState.position.x;
  room.receive(sockets.at(-1), {
    type: 'input',
    input: { up: false, down: false, left: true, right: false },
  });
  room.tick(0.02);
  assert.ok(tenthState.position.x < startX);
  room.coin = { ...tenthState.position };
  room.tick(0.02);
  assert.equal(tenthState.score, 1);

  const vacatedSlot = room.peers.get(sockets[4]).slot;
  room.disconnect(sockets[4]);
  assert.equal(room.running, false);
  const replacement = new FakeSocket();
  join(room, replacement, 'Replacement');
  assert.equal(room.peers.get(replacement).slot, vacatedSlot);
});

test('malformed and over-rate input are rejected fail-closed', () => {
  let now = 0;
  const malformedRoom = makeRoom({ now: () => now });
  const malformed = new FakeSocket();
  join(malformedRoom, malformed, 'Ada');
  assert.equal(malformedRoom.receive(malformed, { type: 'input', input: { up: 'yes' } }), false);
  assert.equal(malformed.closed.code, 1008);

  const rateRoom = makeRoom({ now: () => now });
  const noisy = new FakeSocket();
  join(rateRoom, noisy, 'Grace');
  const valid = { type: 'input', input: { up: false, down: false, left: false, right: false } };
  for (let index = 0; index < 89; index += 1) rateRoom.receive(noisy, valid);
  assert.equal(noisy.closed, null);
  assert.equal(rateRoom.receive(noisy, valid), false);
  assert.equal(noisy.closed.code, 1008);
  assert.match(noisy.closed.reason, /rate/i);
});

test('an eleventh concurrent connection is refused', () => {
  const room = makeRoom();
  for (let index = 0; index < GAME.maxPlayers; index += 1) {
    join(room, new FakeSocket(), `Player ${index + 1}`);
  }
  const eleventh = new FakeSocket();
  assert.equal(room.connect(eleventh), null);
  assert.equal(eleventh.closed.code, 1008);
});
