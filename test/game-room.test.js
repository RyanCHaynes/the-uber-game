import assert from 'node:assert/strict';
import test from 'node:test';

import { GameRoom } from '../server/game-room.js';
import { castleLevel } from '../shared/levels/castle.js';

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
  return new GameRoom({ level: { ...castleLevel, tiles: [...castleLevel.tiles] }, random: () => 0, ...options });
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

test('a third concurrent connection is refused', () => {
  const room = makeRoom();
  join(room, new FakeSocket(), 'One');
  join(room, new FakeSocket(), 'Two');
  const third = new FakeSocket();
  assert.equal(room.connect(third), null);
  assert.equal(third.closed.code, 1008);
});
