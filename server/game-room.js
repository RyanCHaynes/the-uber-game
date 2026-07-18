import {
  ACTION_INPUT_TIMEOUT_MS,
  ACTION_PROTOCOL,
  HELD_ACTIONS,
  PRESSED_ACTIONS,
  validateActionIntent,
} from '../shared/action-protocol.js';
import { GAME, SERVER_MESSAGE, TILE } from '../shared/game.js';
import { isSolid, playerSpawnPositions, positionsFor, prepareLevel } from '../shared/level.js';

function cleanName(value) {
  const printable = String(value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 18);
  return printable || 'Player';
}

function falseRecord(actions) {
  return Object.fromEntries(actions.map((action) => [action, false]));
}

function clearActionState(peer, { resetSequence = false } = {}) {
  if (resetSequence) peer.lastActionSequence = 0;
  peer.lastActionAt = null;
  peer.actionHeld = falseRecord(HELD_ACTIONS);
  peer.actionPressed = falseRecord(PRESSED_ACTIONS);
  peer.currentAction = Object.freeze({
    held: Object.freeze(falseRecord(HELD_ACTIONS)),
    pressed: Object.freeze(falseRecord(PRESSED_ACTIONS)),
  });
}

export class GameRoom {
  constructor({ level, random = Math.random, now = Date.now } = {}) {
    this.level = prepareLevel(level);
    this.random = random;
    this.now = now;
    this.peers = new Map();
    this.players = new Map();
    this.protocol = null;
    this.nextId = 1;
    this.running = false;
    this.gameOver = false;
    this.gameOverElapsed = 0;
    this.snapshotElapsed = 0;
    this.winnerId = null;
    this.coinIndex = -1;
    this.coin = { x: 0, y: 0 };
  }

  get connectionCount() {
    return this.peers.size;
  }

  connect(socket) {
    if (this.peers.size >= GAME.maxPlayers) {
      this.send(socket, { type: SERVER_MESSAGE.NOTICE, text: `This lobby already has ${GAME.maxPlayers} players.` });
      socket.close?.(1008, 'Lobby full');
      return null;
    }
    const occupiedSlots = new Set([...this.peers.values()].map((peer) => peer.slot));
    const slot = Array.from({ length: GAME.maxPlayers }, (_unused, index) => index)
      .find((candidate) => !occupiedSlots.has(candidate));
    const peer = {
      socket,
      id: this.nextId,
      slot,
      joined: false,
      name: '',
      protocol: 'legacy-v1',
      ready: false,
      input: { up: false, down: false, left: false, right: false },
      jumpWasDown: false,
      messageTokens: 90,
      lastMessageAt: this.now(),
    };
    clearActionState(peer, { resetSequence: true });
    this.nextId += 1;
    this.peers.set(socket, peer);
    return peer;
  }

  disconnect(socket) {
    const peer = this.peers.get(socket);
    if (!peer) return;
    this.peers.delete(socket);
    if (!peer.joined) return;
    if (this.running) {
      this.resetToLobby();
      this.broadcastNotice('The match ended because a player disconnected.');
    }
    this.broadcastNotice(`${peer.name} left the lobby.`);
    this.broadcastLobby();
    this.beginGameIfReady();
    if (this.joinedPeers().length === 0) this.protocol = null;
  }

  receive(socket, message, { byteLength = 0 } = {}) {
    const peer = this.peers.get(socket);
    if (!peer) return false;
    if (!this.consumeMessageToken(peer)) return this.reject(peer, 'Message rate exceeded.');
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      return this.reject(peer, 'Malformed message.');
    }

    if (message.type === 'hello') {
      const protocol = message.protocol ?? 'legacy-v1';
      const expectedKeys = protocol === ACTION_PROTOCOL ? ['name', 'protocol', 'type'] : ['name', 'type'];
      const actualKeys = Object.keys(message).sort();
      const exactShape = actualKeys.length === expectedKeys.length && expectedKeys.every((key, index) => key === actualKeys[index]);
      if (peer.joined || this.running || !exactShape ||
          (protocol !== ACTION_PROTOCOL && protocol !== 'legacy-v1') ||
          (this.protocol !== null && this.protocol !== protocol) ||
          typeof message.name !== 'string' || message.name.length > 64) {
        return this.reject(peer, 'Malformed hello or match already in progress.');
      }
      peer.name = this.uniqueName(cleanName(message.name));
      peer.protocol = protocol;
      this.protocol = protocol;
      peer.joined = true;
      this.send(peer.socket, { type: SERVER_MESSAGE.WELCOME, id: peer.id, slot: peer.slot, protocol });
      this.sendLevel(peer.socket);
      this.broadcastNotice(`${peer.name} joined the lobby.`);
      this.broadcastLobby();
      return true;
    }
    if (!peer.joined) return this.reject(peer, 'Hello required.');

    if (message.type === 'ready') {
      if (typeof message.ready !== 'boolean') return this.reject(peer, 'Malformed ready message.');
      if (!this.running) {
        peer.ready = message.ready;
        this.broadcastLobby();
        this.beginGameIfReady();
      }
      return true;
    }
    if (message.type === 'input') {
      if (peer.protocol === ACTION_PROTOCOL) return this.reject(peer, 'Legacy input is not allowed for this protocol.');
      const input = message.input;
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          ['up', 'down', 'left', 'right'].some((key) => typeof input[key] !== 'boolean')) {
        return this.reject(peer, 'Malformed input message.');
      }
      if (this.running) peer.input = { up: input.up, down: input.down, left: input.left, right: input.right };
      return true;
    }
    if (message.type === 'action') {
      if (peer.protocol !== ACTION_PROTOCOL) return this.reject(peer, 'Action input requires action-v1.');
      const result = validateActionIntent(message, { lastSequence: peer.lastActionSequence, byteLength });
      if (!result.ok) return this.reject(peer, `${result.code}: ${result.reason}`);

      peer.lastActionSequence = result.intent.sequence;
      peer.lastActionAt = this.now();
      if (this.running) {
        peer.actionHeld = { ...result.intent.held };
        for (const action of PRESSED_ACTIONS) {
          peer.actionPressed[action] ||= result.intent.pressed[action];
        }
      } else {
        peer.actionHeld = falseRecord(HELD_ACTIONS);
        peer.actionPressed = falseRecord(PRESSED_ACTIONS);
      }
      return true;
    }
    return this.reject(peer, 'Unknown message type.');
  }

  consumeMessageToken(peer) {
    const now = this.now();
    const elapsed = Math.max(0, now - peer.lastMessageAt) / 1000;
    peer.lastMessageAt = now;
    peer.messageTokens = Math.min(90, peer.messageTokens + elapsed * 60);
    if (peer.messageTokens < 1) return false;
    peer.messageTokens -= 1;
    return true;
  }

  reject(peer, reason) {
    this.send(peer.socket, { type: SERVER_MESSAGE.NOTICE, text: reason });
    peer.socket.close?.(1008, reason.slice(0, 120));
    return false;
  }

  setLevel(candidate) {
    if (this.running) throw new Error('Cannot replace the level during a match.');
    const nextLevel = prepareLevel(candidate);
    this.level = nextLevel;
    for (const peer of this.joinedPeers()) this.sendLevel(peer.socket);
    return nextLevel;
  }

  consumeActionForTick(peer) {
    if (peer.protocol !== ACTION_PROTOCOL) return null;
    const timedOut = peer.lastActionAt === null || this.now() - peer.lastActionAt > ACTION_INPUT_TIMEOUT_MS;
    const held = timedOut ? falseRecord(HELD_ACTIONS) : { ...peer.actionHeld };
    const pressed = timedOut ? falseRecord(PRESSED_ACTIONS) : { ...peer.actionPressed };
    peer.actionHeld = held;
    peer.actionPressed = falseRecord(PRESSED_ACTIONS);
    peer.input = { up: held.up, down: held.down, left: held.left, right: held.right };
    peer.currentAction = Object.freeze({ held: Object.freeze({ ...held }), pressed: Object.freeze({ ...pressed }) });
    return peer.currentAction;
  }

  tick(seconds) {
    if (!this.running) return;
    const elapsed = Math.min(Math.max(Number(seconds) || 0, 0), 0.02);
    if (this.gameOver) {
      this.gameOverElapsed += elapsed;
      this.snapshotElapsed += elapsed;
      if (this.snapshotElapsed >= 1 / GAME.snapshotRate) {
        this.snapshotElapsed = 0;
        this.broadcastSnapshot();
      }
      if (this.gameOverElapsed >= GAME.gameOverSeconds) {
        this.resetToLobby();
        this.broadcastLobby();
      }
      return;
    }

    for (const peer of this.joinedPeers()) {
      const state = this.players.get(peer.id);
      if (!state) continue;
      const action = this.consumeActionForTick(peer);
      this.updatePlayer(peer, state, elapsed, action);
      const deltaX = state.position.x - this.coin.x;
      const deltaY = state.position.y - this.coin.y;
      if (Math.abs(deltaX) <= GAME.playerHalfWidth + GAME.coinRadius &&
          Math.abs(deltaY) <= GAME.playerHalfHeight + GAME.coinRadius) {
        state.score += 1;
        if (state.score >= GAME.winningScore) {
          this.winnerId = state.id;
          this.gameOver = true;
          this.gameOverElapsed = 0;
          this.broadcastNotice(`${peer.name} wins! Returning to the lobby...`);
        } else {
          this.moveCoin();
        }
        break;
      }
    }

    this.snapshotElapsed += elapsed;
    if (this.snapshotElapsed >= 1 / GAME.snapshotRate) {
      this.snapshotElapsed = 0;
      this.broadcastSnapshot();
    }
  }

  beginGameIfReady() {
    const peers = this.joinedPeers();
    if (peers.length >= GAME.minPlayers && peers.every((peer) => peer.ready)) this.beginGame();
  }

  beginGame() {
    const spawns = playerSpawnPositions(this.level);
    this.players.clear();
    this.joinedPeers().forEach((peer) => {
      const spawn = spawns[peer.slot];
      this.players.set(peer.id, {
        id: peer.id,
        slot: peer.slot,
        name: peer.name,
        position: {
          x: spawn.x,
          y: spawn.y + this.level.tileSize / 2 - GAME.playerHalfHeight,
        },
        velocity: { x: 0, y: 0 },
        score: 0,
        grounded: true,
      });
      peer.jumpWasDown = false;
      clearActionState(peer);
    });
    this.running = true;
    this.gameOver = false;
    this.gameOverElapsed = 0;
    this.snapshotElapsed = 0;
    this.winnerId = null;
    this.moveCoin();
    for (const peer of this.joinedPeers()) this.sendLevel(peer.socket);
    this.broadcast({ type: SERVER_MESSAGE.GAME_START, revision: this.level.revision });
    this.broadcastNotice(`Go! First player to ${GAME.winningScore} coins wins.`);
    this.broadcastSnapshot();
  }

  updatePlayer(peer, state, seconds, action = null) {
    const horizontal = Number(peer.input.right) - Number(peer.input.left);
    state.velocity.x = horizontal * GAME.playerSpeed;
    const jumpRequested = action ? action.pressed.jump : peer.input.up && !peer.jumpWasDown;
    if (jumpRequested && state.grounded) {
      state.velocity.y = -GAME.jumpSpeed;
      state.grounded = false;
    }
    peer.jumpWasDown = action ? false : peer.input.up;
    state.velocity.y = Math.min(state.velocity.y + GAME.gravity * seconds, GAME.maximumFallSpeed);

    const tileFor = (pixel) => Math.floor(pixel / this.level.tileSize);
    state.position.x += state.velocity.x * seconds;
    const top = tileFor(state.position.y - GAME.playerHalfHeight + 1);
    const bottom = tileFor(state.position.y + GAME.playerHalfHeight - 1);
    if (state.velocity.x > 0) {
      const right = tileFor(state.position.x + GAME.playerHalfWidth);
      for (let y = top; y <= bottom; y += 1) {
        if (isSolid(this.level, right, y)) {
          state.position.x = right * this.level.tileSize - GAME.playerHalfWidth - 0.01;
          state.velocity.x = 0;
          break;
        }
      }
    } else if (state.velocity.x < 0) {
      const left = tileFor(state.position.x - GAME.playerHalfWidth);
      for (let y = top; y <= bottom; y += 1) {
        if (isSolid(this.level, left, y)) {
          state.position.x = (left + 1) * this.level.tileSize + GAME.playerHalfWidth + 0.01;
          state.velocity.x = 0;
          break;
        }
      }
    }

    state.position.y += state.velocity.y * seconds;
    state.grounded = false;
    const left = tileFor(state.position.x - GAME.playerHalfWidth + 1);
    const right = tileFor(state.position.x + GAME.playerHalfWidth - 1);
    if (state.velocity.y >= 0) {
      const bottomTile = tileFor(state.position.y + GAME.playerHalfHeight);
      for (let x = left; x <= right; x += 1) {
        if (isSolid(this.level, x, bottomTile)) {
          state.position.y = bottomTile * this.level.tileSize - GAME.playerHalfHeight - 0.01;
          state.velocity.y = 0;
          state.grounded = true;
          break;
        }
      }
    } else {
      const topTile = tileFor(state.position.y - GAME.playerHalfHeight);
      for (let x = left; x <= right; x += 1) {
        if (isSolid(this.level, x, topTile)) {
          state.position.y = (topTile + 1) * this.level.tileSize + GAME.playerHalfHeight + 0.01;
          state.velocity.y = 0;
          break;
        }
      }
    }
  }

  moveCoin() {
    const spawns = positionsFor(this.level, TILE.COIN_SPAWN);
    let next = Math.min(Math.floor(this.random() * spawns.length), spawns.length - 1);
    if (spawns.length > 1 && next === this.coinIndex) next = (next + 1) % spawns.length;
    this.coinIndex = next;
    this.coin = { ...spawns[next] };
  }

  resetToLobby() {
    this.running = false;
    this.gameOver = false;
    this.gameOverElapsed = 0;
    this.winnerId = null;
    this.players.clear();
    for (const peer of this.peers.values()) {
      peer.ready = false;
      peer.jumpWasDown = false;
      peer.input = { up: false, down: false, left: false, right: false };
      clearActionState(peer);
    }
  }

  joinedPeers() {
    return [...this.peers.values()]
      .filter((peer) => peer.joined)
      .sort((left, right) => left.slot - right.slot);
  }

  uniqueName(base) {
    const taken = new Set(this.joinedPeers().map((peer) => peer.name));
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base.slice(0, 14)} ${suffix}`)) suffix += 1;
    return `${base.slice(0, 14)} ${suffix}`;
  }

  sendLevel(socket) {
    this.send(socket, { type: SERVER_MESSAGE.LEVEL, level: this.level });
  }

  broadcastLobby() {
    this.broadcast({
      type: SERVER_MESSAGE.LOBBY,
      players: this.joinedPeers().map(({ id, slot, name, ready }) => ({ id, slot, name, ready })),
    });
  }

  broadcastSnapshot() {
    this.broadcast({
      type: SERVER_MESSAGE.SNAPSHOT,
      revision: this.level.revision,
      coin: this.coin,
      players: [...this.players.values()].map(({ id, slot, name, position, score }) => ({
        id, slot, name, position, score,
      })),
      winnerId: this.winnerId,
    });
  }

  broadcastNotice(text) {
    this.broadcast({ type: SERVER_MESSAGE.NOTICE, text });
  }

  broadcast(message) {
    for (const peer of this.joinedPeers()) this.send(peer.socket, message);
  }

  send(socket, message) {
    if (socket.readyState !== undefined && socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close event owns cleanup.
    }
  }
}
