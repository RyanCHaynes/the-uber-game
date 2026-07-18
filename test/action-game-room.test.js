import assert from 'node:assert/strict';
import test from 'node:test';

import { GameRoom } from '../server/game-room.js';
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
  return new GameRoom({
    level: {
      ...activeLevelCandidate,
      tiles: [...activeLevelCandidate.tiles],
      spawnTiles: activeLevelCandidate.spawnTiles.map((spawn) => ({ ...spawn })),
    },
    random: () => 0,
    ...options,
  });
}

function action(sequence, { held = {}, pressed = {}, extra = {} } = {}) {
  return {
    type: 'action',
    sequence,
    held: { left: false, right: false, up: false, down: false, ...held },
    pressed: {
      jump: false,
      primary: false,
      secondary: false,
      interact: false,
      dodge: false,
      pause: false,
      ...pressed,
    },
    ...extra,
  };
}

function joinAction(room, socket, name) {
  room.connect(socket);
  assert.equal(room.receive(socket, { type: 'hello', name, protocol: 'action-v1' }), true);
}

function startActionRoom(room) {
  const first = new FakeSocket();
  const second = new FakeSocket();
  joinAction(room, first, 'Ada');
  joinAction(room, second, 'Grace');
  room.receive(first, { type: 'ready', ready: true });
  room.receive(second, { type: 'ready', ready: true });
  assert.equal(room.running, true);
  return { first, second };
}

test('action-v1 applies directional holds and jump edges under server authority', () => {
  let now = 0;
  const room = makeRoom({ now: () => now });
  const { first } = startActionRoom(room);
  const peer = room.peers.get(first);
  const player = room.players.get(peer.id);
  const startX = player.position.x;
  const startY = player.position.y;

  assert.equal(room.receive(first, action(1, { held: { up: true, right: true } })), true);
  room.tick(0.02);
  assert.ok(player.position.x > startX);
  assert.ok(Math.abs(player.position.y - startY) < 0.02);
  assert.equal(player.velocity.y, 0, 'W/up is directional intent, not a jump');
  assert.equal(peer.currentAction.held.up, true);

  assert.equal(room.receive(first, action(2, { pressed: { jump: true, primary: true } })), true);
  room.tick(0.02);
  assert.ok(player.velocity.y < 0);
  assert.equal(peer.currentAction.pressed.jump, true);
  assert.equal(peer.currentAction.pressed.primary, true);

  room.tick(0.02);
  assert.equal(peer.currentAction.pressed.jump, false);
  assert.equal(peer.currentAction.pressed.primary, false);
});

test('stale, authority-bearing, malformed, and oversized action messages have no gameplay mutation', () => {
  let now = 0;
  for (const invalid of [
    action(1, { extra: { position: { x: 999, y: 999 } } }),
    action(1, { pressed: { jump: 'yes' } }),
  ]) {
    const room = makeRoom({ now: () => now });
    const { first } = startActionRoom(room);
    const peer = room.peers.get(first);
    const before = { sequence: peer.lastActionSequence, held: { ...peer.actionHeld } };
    assert.equal(room.receive(first, invalid), false);
    assert.deepEqual({ sequence: peer.lastActionSequence, held: peer.actionHeld }, before);
    assert.equal(first.closed.code, 1008);
  }

  const staleRoom = makeRoom({ now: () => now });
  const { first: staleSocket } = startActionRoom(staleRoom);
  const stalePeer = staleRoom.peers.get(staleSocket);
  assert.equal(staleRoom.receive(staleSocket, action(1, { held: { right: true } })), true);
  const accepted = { sequence: stalePeer.lastActionSequence, held: { ...stalePeer.actionHeld } };
  assert.equal(staleRoom.receive(staleSocket, action(1, { held: { left: true } })), false);
  assert.deepEqual({ sequence: stalePeer.lastActionSequence, held: stalePeer.actionHeld }, accepted);
  assert.match(staleSocket.closed.reason, /stale_action_sequence/);

  const largeRoom = makeRoom({ now: () => now });
  const { first: largeSocket } = startActionRoom(largeRoom);
  const largePeer = largeRoom.peers.get(largeSocket);
  assert.equal(largeRoom.receive(largeSocket, action(1), { byteLength: 2049 }), false);
  assert.equal(largePeer.lastActionSequence, 0);
  assert.match(largeSocket.closed.reason, /payload_too_large/);
});

test('action holds neutralize after 500 ms of client silence', () => {
  let now = 0;
  const room = makeRoom({ now: () => now });
  const { first } = startActionRoom(room);
  const peer = room.peers.get(first);
  const player = room.players.get(peer.id);

  room.receive(first, action(1, { held: { right: true } }));
  room.tick(0.02);
  const movedX = player.position.x;
  assert.equal(peer.currentAction.held.right, true);

  now = 501;
  room.tick(0.02);
  assert.equal(player.position.x, movedX);
  assert.equal(peer.currentAction.held.right, false);
});

test('action sequence and rate limits reject without weakening the existing token bucket', () => {
  let now = 0;
  const room = makeRoom({ now: () => now });
  const socket = new FakeSocket();
  joinAction(room, socket, 'Ada');
  for (let sequence = 1; sequence <= 89; sequence += 1) {
    assert.equal(room.receive(socket, action(sequence)), true);
  }
  assert.equal(socket.closed, null);
  assert.equal(room.receive(socket, action(90)), false);
  assert.match(socket.closed.reason, /rate/i);
});

test('a room rejects mixed legacy and action protocol peers', () => {
  const room = makeRoom();
  const actionSocket = new FakeSocket();
  const legacySocket = new FakeSocket();
  joinAction(room, actionSocket, 'Ada');
  room.connect(legacySocket);
  assert.equal(room.receive(legacySocket, { type: 'hello', name: 'Grace' }), false);
  assert.equal(legacySocket.closed.code, 1008);
  assert.equal(room.protocol, 'action-v1');
});
