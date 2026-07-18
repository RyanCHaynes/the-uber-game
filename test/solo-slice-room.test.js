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

test('one player starts from JSON, accepts exactly five jumps, and reaches the JSON exit', () => {
  let now = 0;
  const room = new SoloSliceRoom({ now: () => now });
  const socket = join(room);
  const start = socket.messages.find((message) => message.type === 'sliceStart');
  assert.equal(start.level.schema, 'token-rush-level/v1');
  assert.equal(start.level.id, 'crypt-fallback');
  assert.deepEqual(start.level.spawn, { x: 80, y: 616 });
  assert.equal(start.level.solids.length, 5);
  assert.equal(start.level.enemies.length, 3);
  assert.equal(start.level.tokens.length, 4);

  const sendInput = inputSender(room, socket);
  sendInput({ right: true });
  for (let step = 0; step < 4000 && !room.complete; step += 1) {
    if (room.player.grounded && room.player.jumpCount < 5) {
      sendInput({ jump: true });
      room.tick(0.02);
      now += 20;
      sendInput({ jump: false });
    }
    room.tick(0.02);
    now += 20;
  }

  assert.equal(room.complete, true);
  assert.equal(room.player.jumpCount, 5);
  assert.ok(room.player.position.x >= room.level.exit.x - SLICE.playerHalfWidth);
  assert.ok(room.player.health < room.player.maxHealth, 'JSON enemies never produced player-hurt feedback');
  const feedbackTypes = new Set(room.feedback.map((event) => event.type));
  for (const type of ['jump', 'playerHurt', 'complete']) {
    assert.equal(feedbackTypes.has(type), true, `missing ${type}`);
  }
  assert.equal(room.feedback.find((event) => event.type === 'complete')?.text, 'Token Rush complete. Gate reached.');
  assert.equal(room.feedback.some((event) => /\d+\s*(?:\/\s*5)?\s*jumps?/i.test(event.text)), false);

  room.broadcastSnapshot();
  const snapshot = socket.messages.at(-1);
  assert.equal(snapshot.type, 'sliceSnapshot');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.player.jumpCount, 5);
  assert.equal(snapshot.enemies.length, 3);
  assert.equal(snapshot.tokens.length, 4);
});

test('death freezes authority and restart resets the same pinned level before a five-jump completion', () => {
  const room = new SoloSliceRoom();
  const socket = join(room, 'Restart Runner');
  const sendInput = inputSender(room, socket);
  const originalPeer = room.peer;
  const originalLevel = room.level;
  const originalStarts = socket.messages.filter((message) => message.type === 'sliceStart').length;

  room.player.health = 1;
  room.player.jumpCount = 4;
  room.tokens[0].x = room.player.position.x;
  room.tokens[0].y = room.player.position.y;
  room.tokens[0].collected = false;
  room.enemies[1].health = 0;
  room.enemies[1].alive = false;
  room.enemies[1].position.x += 100;
  room.complete = false;
  room.enemies[0].position = { ...room.player.position };
  for (const enemy of room.enemies.slice(1)) enemy.attackCooldown = 99;
  sendInput({ right: true, attack: true });
  room.updateEnemies(0.02);

  assert.equal(room.player.health, 0);
  assert.equal(room.dead, true);
  assert.deepEqual(room.input, { left: false, right: false, jump: false, attack: false });
  assert.deepEqual(room.player.velocity, { x: 0, y: 0 });
  assert.equal(room.player.attackTicks, 0);
  const deathEvent = room.feedback.at(-1);
  assert.equal(deathEvent.type, 'playerDeath');
  room.collectTokens();
  assert.equal(room.tokens[0].collected, false);
  const attackTarget = room.enemies[2];
  attackTarget.position = { x: room.player.position.x + 20, y: room.player.position.y };
  const targetHealth = attackTarget.health;
  room.resolvePlayerAttack();
  assert.equal(attackTarget.health, targetHealth);
  room.player.position = {
    x: room.level.exit.x + room.level.exit.width / 2,
    y: room.level.exit.y + room.level.exit.height / 2,
  };
  room.checkExit();
  assert.equal(room.complete, false);
  const frozenPosition = { ...room.player.position };
  const frozenTick = room.tickNumber;

  sendInput({ right: true, jump: true, attack: true });
  assert.deepEqual(room.input, { left: false, right: false, jump: false, attack: false });
  for (let step = 0; step < 20; step += 1) room.tick(0.02);
  assert.deepEqual(room.player.position, frozenPosition);
  assert.equal(room.player.jumpCount, 4);
  assert.equal(room.tickNumber, frozenTick);
  assert.equal(room.tokens[0].collected, false);
  assert.equal(room.complete, false);

  const sequenceBeforeRestart = room.lastInputSequence;
  assert.equal(room.receive(socket, { type: 'sliceRestart' }), true);
  assert.equal(room.peer, originalPeer);
  assert.equal(room.peer.socket, socket);
  assert.equal(socket.closed, null);
  assert.equal(room.level, originalLevel);
  assert.equal(room.dead, false);
  assert.equal(room.complete, false);
  assert.equal(room.tickNumber, 0);
  assert.equal(room.player.name, 'Restart Runner');
  assert.deepEqual(room.player.position, room.level.spawn);
  assert.equal(room.player.health, room.player.maxHealth);
  assert.equal(room.player.jumpCount, 0);
  assert.deepEqual(room.input, { left: false, right: false, jump: false, attack: false });
  assert.equal(room.lastInputSequence, sequenceBeforeRestart);
  assert.deepEqual(room.enemies.map(({ health, maxHealth, alive }) => ({ health, maxHealth, alive })), [
    { health: 1, maxHealth: 1, alive: true },
    { health: 2, maxHealth: 2, alive: true },
    { health: 3, maxHealth: 3, alive: true },
  ]);
  assert.deepEqual(room.enemies.map((enemy) => enemy.position), room.level.enemies.map((enemy) => enemy.position));
  assert.deepEqual(room.tokens, room.level.tokens.map((token) => ({ ...token, collected: false })));
  assert.equal(socket.messages.filter((message) => message.type === 'sliceStart').length, originalStarts + 1);
  const restartEvent = room.feedback.at(-1);
  assert.equal(restartEvent.type, 'restart');
  assert.ok(restartEvent.id > deathEvent.id);

  sendInput({ right: true, jump: false, attack: false });
  for (let step = 0; step < 4000 && !room.complete; step += 1) {
    if (room.player.grounded && room.player.jumpCount < 5) {
      sendInput({ jump: true });
      room.tick(0.02);
      sendInput({ jump: false });
    }
    room.tick(0.02);
  }
  assert.equal(room.complete, true);
  assert.equal(room.dead, false);
  assert.equal(room.player.jumpCount, 5);
});

test('restart after completion clears the finish state on the same peer and level', () => {
  const room = new SoloSliceRoom();
  const socket = join(room);
  const peer = room.peer;
  const level = room.level;
  room.complete = true;
  room.player.position = { x: room.level.exit.x + 1, y: room.level.exit.y + 1 };
  room.player.health = 2;
  room.player.jumpCount = 5;
  room.enemies[0].alive = false;
  room.enemies[0].health = 0;
  room.tokens[0].collected = true;

  assert.equal(room.receive(socket, { type: 'sliceRestart' }), true);
  assert.equal(room.peer, peer);
  assert.equal(room.level, level);
  assert.equal(room.complete, false);
  assert.equal(room.dead, false);
  assert.deepEqual(room.player.position, level.spawn);
  assert.equal(room.player.health, room.player.maxHealth);
  assert.equal(room.player.jumpCount, 0);
  assert.equal(room.enemies.every((enemy) => enemy.alive && enemy.health === enemy.maxHealth), true);
  assert.equal(room.tokens.every((token) => !token.collected), true);
});

test('restart preserves the input replay high-water mark', () => {
  const room = new SoloSliceRoom();
  const socket = join(room);
  assert.equal(room.receive(socket, {
    type: 'sliceInput',
    sequence: 41,
    input: { left: false, right: false, jump: false, attack: false },
  }), true);
  room.dead = true;
  room.player.health = 0;
  assert.equal(room.receive(socket, { type: 'sliceRestart' }), true);
  assert.equal(room.lastInputSequence, 41);
  assert.equal(room.receive(socket, {
    type: 'sliceInput',
    sequence: 41,
    input: { left: false, right: true, jump: false, attack: false },
  }), false);
  assert.equal(socket.closed?.code, 1008);
});

test('authoritative snapshots preserve a 20 Hz average without dropping accumulator remainder', () => {
  let now = 0;
  const room = new SoloSliceRoom({ now: () => now });
  const socket = join(room);
  const initialSnapshots = socket.messages.filter((message) => message.type === 'sliceSnapshot').length;
  for (let tick = 0; tick < SLICE.tickRate; tick += 1) {
    room.tick(1 / SLICE.tickRate);
    now += 1000 / SLICE.tickRate;
  }
  const snapshots = socket.messages.filter((message) => message.type === 'sliceSnapshot').length - initialSnapshots;
  assert.equal(snapshots, SLICE.snapshotRate);
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


test('allowlisted enemy types change authoritative health and chase speed', () => {
  const room = new SoloSliceRoom();
  room.player.position = { x: 500, y: 612 };
  for (const enemy of room.enemies) enemy.position = { x: 400, y: 612 };
  room.updateEnemies(0.1);
  assert.deepEqual(room.enemies.map((enemy) => enemy.maxHealth), [1, 2, 3]);
  assert.deepEqual(room.enemies.map((enemy) => Number((enemy.position.x - 400).toFixed(1))), [7.8, 5.2, 5.8]);
});
