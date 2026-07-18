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
