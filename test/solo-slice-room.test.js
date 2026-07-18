import assert from 'node:assert/strict';
import test from 'node:test';

import { SLICE, SoloSliceRoom } from '../server/solo-slice-room.js';

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.messages = [];
    this.closed = null;
  }

  send(payload) {
    this.messages.push(JSON.parse(payload));
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function join(room, name = 'Solo Tester') {
  const socket = new FakeSocket();
  const peer = room.connect(socket);
  assert.ok(peer);
  assert.equal(room.receive(socket, { type: 'hello', name }), true);
  assert.equal(room.running, true);
  assert.equal(socket.messages.some((message) => message.type === 'sliceStart'), true);
  return socket;
}

function inputSender(room, socket) {
  let sequence = 0;
  let state = { left: false, right: false, jump: false, attack: false };
  return (patch) => {
    state = { ...state, ...patch };
    assert.equal(room.receive(socket, { type: 'sliceInput', sequence: sequence++, input: state }), true);
  };
}

test('one player starts immediately, clears exactly five jumps, receives combat feedback, and defeats the mob', () => {
  let now = 0;
  const room = new SoloSliceRoom({ now: () => now });
  const socket = join(room);
  const sendInput = inputSender(room, socket);
  sendInput({ right: true });

  let nextObstacle = 0;
  for (let step = 0; step < 5000 && room.player.position.x < 1360; step += 1) {
    const obstacle = SLICE.obstacles[nextObstacle];
    if (obstacle && room.player.grounded && room.player.position.x >= obstacle.x - 72) {
      sendInput({ jump: true });
      room.tick(0.02);
      now += 20;
      sendInput({ jump: false });
    }
    room.tick(0.02);
    now += 20;
    if (obstacle && room.player.position.x > obstacle.x + obstacle.width + SLICE.playerHalfWidth) {
      nextObstacle += 1;
    }
  }

  assert.equal(nextObstacle, 5);
  assert.equal(room.player.jumpCount, 5);
  assert.ok(room.player.position.x >= 1360, `player stalled at ${room.player.position.x}`);

  sendInput({ right: true });
  for (let step = 0; step < 500 && room.player.health === room.player.maxHealth; step += 1) {
    room.tick(0.02);
    now += 20;
  }
  assert.ok(room.player.health < room.player.maxHealth, 'enemy never produced player-hurt feedback');

  sendInput({ right: false });
  for (let step = 0; step < 2000 && room.enemy.alive; step += 1) {
    const dx = room.enemy.position.x - room.player.position.x;
    if (Math.abs(dx) > SLICE.attackRange - 8) sendInput({ right: dx > 0, left: dx < 0 });
    else sendInput({ right: false, left: false });
    if (room.player.attackCooldown === 0 && Math.abs(dx) <= SLICE.attackRange) {
      sendInput({ attack: true });
      room.tick(0.02);
      now += 20;
      sendInput({ attack: false });
    }
    room.tick(0.02);
    now += 20;
  }

  assert.equal(room.enemy.alive, false);
  assert.equal(room.enemy.health, 0);
  assert.equal(room.complete, true);
  assert.equal(room.player.jumpCount, 5);
  const feedbackTypes = new Set(room.feedback.map((event) => event.type));
  for (const type of ['jump', 'playerAttack', 'enemyHit', 'playerHurt', 'enemyDeath', 'complete']) {
    assert.equal(feedbackTypes.has(type), true, `missing ${type}`);
  }
  room.broadcastSnapshot();
  const snapshot = socket.messages.at(-1);
  assert.equal(snapshot.type, 'sliceSnapshot');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.player.jumpCount, 5);
});

test('solo slice rejects a second client and malformed or stale input fail-closed', () => {
  let now = 0;
  const room = new SoloSliceRoom({ now: () => now });
  const first = join(room, 'First');
  const second = new FakeSocket();
  assert.equal(room.connect(second), null);
  assert.deepEqual(second.closed, { code: 1008, reason: 'Solo preview occupied' });

  assert.equal(room.receive(first, {
    type: 'sliceInput',
    sequence: 0,
    input: { left: false, right: true, jump: false, attack: false },
  }), true);
  now += 20;
  assert.equal(room.receive(first, {
    type: 'sliceInput',
    sequence: 0,
    input: { left: false, right: true, jump: false, attack: false },
  }), false);
  assert.equal(first.closed?.code, 1008);
});
