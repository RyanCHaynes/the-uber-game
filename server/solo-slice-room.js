import {
  compileTokenRushLevel,
  FALLBACK_TOKEN_RUSH_LEVEL,
  TOKEN_RUSH_ACTOR_BODIES,
} from '../shared/token-rush-level.js';
import { TokenRushEnemyRuntime } from './token-rush-enemy-runtime.js';

const SLICE = Object.freeze({
  revision: 'token-rush-level-runtime-v1',
  tickRate: 50,
  snapshotRate: 20,
  playerSpeed: 245,
  gravity: 1450,
  jumpSpeed: 570,
  playerHalfWidth: TOKEN_RUSH_ACTOR_BODIES.player.halfWidth,
  playerHalfHeight: TOKEN_RUSH_ACTOR_BODIES.player.halfHeight,
  attackCooldownTicks: 16,
});

function cleanName(value) {
  const printable = String(value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 18);
  return printable || 'Player';
}

function overlapsVertically(positionY, halfHeight, top, bottom) {
  return positionY + halfHeight > top && positionY - halfHeight < bottom;
}

function overlapsRectangle(position, halfWidth, halfHeight, rectangle) {
  return position.x + halfWidth > rectangle.x &&
    position.x - halfWidth < rectangle.x + rectangle.width &&
    position.y + halfHeight > rectangle.y &&
    position.y - halfHeight < rectangle.y + rectangle.height;
}

export class SoloSliceRoom {
  constructor({ now = Date.now, level = compileTokenRushLevel(FALLBACK_TOKEN_RUSH_LEVEL) } = {}) {
    this.now = now;
    this.level = level;
    this.peer = null;
    this.running = false;
    this.complete = false;
    this.tickNumber = 0;
    this.snapshotElapsed = 0;
    this.eventSequence = 0;
    this.feedback = [];
    this.resetState();
  }

  get connectionCount() {
    return this.peer ? 1 : 0;
  }

  resetState() {
    this.player = {
      id: 1,
      name: 'Player',
      position: { ...this.level.spawn },
      velocity: { x: 0, y: 0 },
      facing: 1,
      grounded: true,
      health: 5,
      maxHealth: 5,
      jumpCount: 0,
      attackCooldown: 0,
      attackTicks: 0,
      invulnerabilityTicks: 0,
    };
    this.enemyRuntime = new TokenRushEnemyRuntime({
      level: this.level,
      emitFeedback: (type, text) => this.emitFeedback(type, text),
      killPlayer: (enemy) => this.killPlayer(enemy),
    });
    this.enemies = this.enemyRuntime.entities;
    this.enemy = this.enemies.at(-1) ?? null;
    this.tokens = this.level.tokens.map((token) => ({ ...token, collected: false }));
    this.dead = false;
    this.input = { left: false, right: false, jump: false, attack: false };
    this.previousInput = { ...this.input };
    this.lastInputSequence = -1;
  }

  connect(socket) {
    if (this.peer) {
      this.send(socket, { type: 'sliceNotice', text: 'The solo preview is already occupied.' });
      socket.close?.(1008, 'Solo preview occupied');
      return null;
    }
    this.peer = {
      socket,
      joined: false,
      messageTokens: 90,
      lastMessageAt: this.now(),
    };
    return this.peer;
  }

  disconnect(socket) {
    if (!this.peer || this.peer.socket !== socket) return;
    this.peer = null;
    this.running = false;
    this.complete = false;
    this.tickNumber = 0;
    this.snapshotElapsed = 0;
    this.feedback = [];
    this.resetState();
  }

  receive(socket, message) {
    const peer = this.peer;
    if (!peer || peer.socket !== socket) return false;
    if (!this.consumeMessageToken(peer)) return this.reject(peer, 'Message rate exceeded.');
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      return this.reject(peer, 'Malformed message.');
    }

    if (message.type === 'hello') {
      if (peer.joined || typeof message.name !== 'string' || message.name.length > 64) {
        return this.reject(peer, 'Malformed hello.');
      }
      peer.joined = true;
      this.player.name = cleanName(message.name);
      this.running = true;
      this.send(socket, { type: 'sliceWelcome', id: this.player.id, revision: this.level.revision });
      this.send(socket, { type: 'sliceStart', level: this.levelPayload() });
      this.emitFeedback('notice', 'Collect tokens, survive the crypt, and reach the gate.');
      this.broadcastSnapshot();
      return true;
    }

    if (!peer.joined) return this.reject(peer, 'Hello required.');
    if (message.type === 'sliceRestart') {
      if (Object.keys(message).length !== 1 || (!this.dead && !this.complete)) {
        return this.reject(peer, 'Restart unavailable.');
      }
      this.restartRound();
      return true;
    }
    if (message.type !== 'sliceInput') return this.reject(peer, 'Unknown message type.');
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= this.lastInputSequence) {
      return this.reject(peer, 'Invalid input sequence.');
    }
    const input = message.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ['left', 'right', 'jump', 'attack'].some((key) => typeof input[key] !== 'boolean')) {
      return this.reject(peer, 'Malformed input.');
    }
    this.lastInputSequence = message.sequence;
    this.input = this.dead || this.complete
      ? { left: false, right: false, jump: false, attack: false }
      : { left: input.left, right: input.right, jump: input.jump, attack: input.attack };
    return true;
  }

  restartRound() {
    const name = this.player.name;
    const lastInputSequence = this.lastInputSequence;
    this.complete = false;
    this.tickNumber = 0;
    this.snapshotElapsed = 0;
    this.feedback = [];
    this.resetState();
    this.player.name = name;
    this.lastInputSequence = lastInputSequence;
    this.send(this.peer?.socket, { type: 'sliceStart', level: this.levelPayload() });
    this.emitFeedback('restart', 'The crypt resets. Try again.');
    this.broadcastSnapshot();
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
    this.send(peer.socket, { type: 'sliceNotice', text: reason });
    peer.socket.close?.(1008, reason.slice(0, 120));
    return false;
  }

  tick(seconds) {
    if (!this.running || !this.peer?.joined) return;
    const elapsed = Math.min(Math.max(Number(seconds) || 0, 0), 0.02);
    if (!this.complete && !this.dead) {
      this.updatePlayer(elapsed);
      this.updateEnemies(elapsed);
      if (!this.dead) {
        this.collectTokens();
        this.checkExit();
      }
      this.tickNumber += 1;
    }
    this.snapshotElapsed += elapsed;
    const snapshotInterval = 1 / SLICE.snapshotRate;
    if (this.snapshotElapsed + 1e-9 >= snapshotInterval) {
      this.snapshotElapsed = Math.max(0, this.snapshotElapsed - snapshotInterval);
      this.broadcastSnapshot();
    }
    this.previousInput = { ...this.input };
  }

  updatePlayer(seconds) {
    if (this.dead) return;
    const player = this.player;
    const horizontal = Number(this.input.right) - Number(this.input.left);
    player.velocity.x = horizontal * SLICE.playerSpeed;
    if (horizontal) player.facing = Math.sign(horizontal);

    const jumpEdge = this.input.jump && !this.previousInput.jump;
    if (jumpEdge && player.grounded) {
      player.velocity.y = -SLICE.jumpSpeed;
      player.grounded = false;
      player.jumpCount += 1;
      this.emitFeedback('jump', 'Leap!');
    }

    const attackEdge = this.input.attack && !this.previousInput.attack;
    if (attackEdge && player.attackCooldown === 0) {
      player.attackCooldown = SLICE.attackCooldownTicks;
      player.attackTicks = 7;
      this.emitFeedback('playerAttack', 'Slash!');
      this.resolvePlayerAttack();
    }

    if (player.attackCooldown > 0) player.attackCooldown -= 1;
    if (player.attackTicks > 0) player.attackTicks -= 1;
    if (player.invulnerabilityTicks > 0) player.invulnerabilityTicks -= 1;

    player.velocity.y = Math.min(player.velocity.y + SLICE.gravity * seconds, 760);
    this.movePlayerHorizontally(player.velocity.x * seconds);
    this.movePlayerVertically(player.velocity.y * seconds);
  }

  movePlayerHorizontally(deltaX) {
    const player = this.player;
    let nextX = Math.max(SLICE.playerHalfWidth, Math.min(this.level.width - SLICE.playerHalfWidth, player.position.x + deltaX));
    for (const solid of this.level.solids) {
      if (!overlapsVertically(player.position.y, SLICE.playerHalfHeight, solid.y, solid.y + solid.height)) continue;
      const left = solid.x;
      const right = solid.x + solid.width;
      if (deltaX > 0 && player.position.x + SLICE.playerHalfWidth <= left && nextX + SLICE.playerHalfWidth > left) {
        nextX = left - SLICE.playerHalfWidth;
        player.velocity.x = 0;
      } else if (deltaX < 0 && player.position.x - SLICE.playerHalfWidth >= right && nextX - SLICE.playerHalfWidth < right) {
        nextX = right + SLICE.playerHalfWidth;
        player.velocity.x = 0;
      }
    }
    player.position.x = nextX;
  }

  movePlayerVertically(deltaY) {
    const player = this.player;
    const previousTop = player.position.y - SLICE.playerHalfHeight;
    const previousBottom = player.position.y + SLICE.playerHalfHeight;
    let nextY = player.position.y + deltaY;
    player.grounded = false;
    if (deltaY >= 0) {
      let landingY = this.level.height;
      for (const solid of this.level.solids) {
        const horizontallyOver = player.position.x + SLICE.playerHalfWidth > solid.x &&
          player.position.x - SLICE.playerHalfWidth < solid.x + solid.width;
        if (horizontallyOver && previousBottom <= solid.y && nextY + SLICE.playerHalfHeight >= solid.y) {
          landingY = Math.min(landingY, solid.y);
        }
      }
      if (nextY + SLICE.playerHalfHeight >= landingY) {
        nextY = landingY - SLICE.playerHalfHeight;
        player.velocity.y = 0;
        player.grounded = true;
      }
    } else {
      let ceilingY = -Infinity;
      for (const solid of this.level.solids) {
        const horizontallyOver = player.position.x + SLICE.playerHalfWidth > solid.x &&
          player.position.x - SLICE.playerHalfWidth < solid.x + solid.width;
        const bottom = solid.y + solid.height;
        if (horizontallyOver && previousTop >= bottom && nextY - SLICE.playerHalfHeight <= bottom) {
          ceilingY = Math.max(ceilingY, bottom);
        }
      }
      if (ceilingY > -Infinity) {
        nextY = ceilingY + SLICE.playerHalfHeight;
        player.velocity.y = 0;
      }
    }
    player.position.y = nextY;
  }

  resolvePlayerAttack() {
    if (this.dead) return;
    this.enemyRuntime.resolvePlayerAttack(this.player);
  }

  updateEnemies(seconds) {
    if (this.dead) return;
    this.enemyRuntime.update(seconds, this.player);
    this.enemy = this.enemies.at(-1) ?? null;
  }

  killPlayer(enemy) {
    if (this.dead) return;
    this.dead = true;
    this.input = { left: false, right: false, jump: false, attack: false };
    this.previousInput = { ...this.input };
    this.player.velocity = { x: 0, y: 0 };
    this.player.attackTicks = 0;
    this.emitFeedback('playerDeath', `${enemy.name} defeated you`);
  }

  collectTokens() {
    if (this.dead) return;
    for (const token of this.tokens) {
      if (token.collected) continue;
      if (Math.abs(token.x - this.player.position.x) <= 32 && Math.abs(token.y - this.player.position.y) <= 44) {
        token.collected = true;
        this.emitFeedback('token', 'Token claimed');
      }
    }
  }

  checkExit() {
    if (this.dead) return;
    if (!overlapsRectangle(this.player.position, SLICE.playerHalfWidth, SLICE.playerHalfHeight, this.level.exit)) return;
    this.complete = true;
    this.emitFeedback('complete', 'Token Rush complete. Gate reached.');
  }

  emitFeedback(type, text) {
    this.feedback.push({ id: ++this.eventSequence, tick: this.tickNumber, type, text });
    if (this.feedback.length > 24) this.feedback.shift();
  }

  levelPayload() {
    return {
      schema: this.level.schema,
      id: this.level.id,
      revision: this.level.revision,
      enemyCatalogRevision: this.level.enemyCatalogRevision,
      tileSize: this.level.tileSize,
      width: this.level.width,
      height: this.level.height,
      floorY: this.level.floorY,
      spawn: { ...this.level.spawn },
      exit: { ...this.level.exit },
      solids: this.level.solids.map((solid) => ({ ...solid })),
      enemies: this.level.enemies.map((enemy) => ({ id: enemy.id, type: enemy.type, name: enemy.name, position: { ...enemy.position } })),
      tokens: this.level.tokens.map((token) => ({ ...token })),
      tickRate: SLICE.tickRate,
      snapshotRate: SLICE.snapshotRate,
    };
  }

  broadcastSnapshot() {
    const enemies = this.enemyRuntime.snapshot();
    this.send(this.peer?.socket, {
      type: 'sliceSnapshot',
      revision: this.level.revision,
      tick: this.tickNumber,
      complete: this.complete,
      dead: this.dead,
      player: {
        id: this.player.id,
        name: this.player.name,
        position: { ...this.player.position },
        facing: this.player.facing,
        grounded: this.player.grounded,
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        jumpCount: this.player.jumpCount,
        attacking: this.player.attackTicks > 0,
      },
      enemy: enemies.at(-1) ?? null,
      enemies,
      tokens: this.tokens.map((token) => ({ ...token })),
      feedback: this.feedback.map((event) => ({ ...event })),
    });
  }

  send(socket, message) {
    if (!socket || (socket.readyState !== undefined && socket.readyState !== 1)) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Socket close owns cleanup.
    }
  }
}

export { SLICE };
