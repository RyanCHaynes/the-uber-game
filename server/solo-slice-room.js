import {
  compileTokenRushLevel,
  FALLBACK_TOKEN_RUSH_LEVEL,
  TOKEN_RUSH_ACTOR_BODIES,
} from '../shared/token-rush-level.js';

const SLICE = Object.freeze({
  revision: 'token-rush-level-runtime-v1',
  tickRate: 50,
  snapshotRate: 20,
  playerSpeed: 245,
  gravity: 1450,
  jumpSpeed: 570,
  playerHalfWidth: TOKEN_RUSH_ACTOR_BODIES.player.halfWidth,
  playerHalfHeight: TOKEN_RUSH_ACTOR_BODIES.player.halfHeight,
  enemyHalfWidth: TOKEN_RUSH_ACTOR_BODIES.enemy.halfWidth,
  enemyHalfHeight: TOKEN_RUSH_ACTOR_BODIES.enemy.halfHeight,
  attackRange: 72,
  attackCooldownTicks: 16,
  enemyAttackCooldownTicks: 42,
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
    this.enemies = this.level.enemies.map((enemy) => ({
      id: enemy.id,
      type: enemy.type,
      name: enemy.name,
      position: { ...enemy.position },
      health: enemy.health,
      maxHealth: enemy.health,
      speed: enemy.speed,
      alive: true,
      facing: -1,
      attackCooldown: 0,
      hitTicks: 0,
    }));
    this.enemy = this.enemies.at(-1) ?? null;
    this.tokens = this.level.tokens.map((token) => ({ ...token, collected: false }));
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
    this.input = { left: input.left, right: input.right, jump: input.jump, attack: input.attack };
    return true;
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
    if (!this.complete) {
      this.updatePlayer(elapsed);
      this.updateEnemies(elapsed);
      this.collectTokens();
      this.checkExit();
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
    const player = this.player;
    const targets = this.enemies
      .filter((enemy) => enemy.alive)
      .map((enemy) => ({ enemy, dx: enemy.position.x - player.position.x }))
      .filter(({ enemy, dx }) => Math.sign(dx || player.facing) === player.facing &&
        Math.abs(dx) <= SLICE.attackRange && Math.abs(enemy.position.y - player.position.y) <= 58)
      .sort((left, right) => Math.abs(left.dx) - Math.abs(right.dx));
    const enemy = targets[0]?.enemy;
    if (!enemy) return;
    enemy.health -= 1;
    enemy.hitTicks = 8;
    this.emitFeedback('enemyHit', `${enemy.name} -1`);
    if (enemy.health <= 0) {
      enemy.health = 0;
      enemy.alive = false;
      this.emitFeedback('enemyDeath', `${enemy.name} defeated`);
    }
  }

  updateEnemies(seconds) {
    const player = this.player;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      if (enemy.hitTicks > 0) enemy.hitTicks -= 1;
      if (enemy.attackCooldown > 0) enemy.attackCooldown -= 1;
      const dx = player.position.x - enemy.position.x;
      enemy.facing = dx < 0 ? -1 : 1;
      if (Math.abs(dx) < 300 && Math.abs(dx) > 42) {
        enemy.position.x += Math.sign(dx) * enemy.speed * seconds;
        enemy.position.x = Math.max(SLICE.enemyHalfWidth, Math.min(this.level.width - SLICE.enemyHalfWidth, enemy.position.x));
      }
      if (Math.abs(dx) <= 46 && Math.abs(enemy.position.y - player.position.y) <= 58 &&
          enemy.attackCooldown === 0 && player.invulnerabilityTicks === 0) {
        enemy.attackCooldown = SLICE.enemyAttackCooldownTicks;
        player.invulnerabilityTicks = 24;
        player.health = Math.max(1, player.health - 1);
        this.emitFeedback('playerHurt', `${enemy.name} hits you`);
      }
    }
  }

  collectTokens() {
    for (const token of this.tokens) {
      if (token.collected) continue;
      if (Math.abs(token.x - this.player.position.x) <= 32 && Math.abs(token.y - this.player.position.y) <= 44) {
        token.collected = true;
        this.emitFeedback('token', 'Token claimed');
      }
    }
  }

  checkExit() {
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
    const enemies = this.enemies.map((enemy) => ({
      id: enemy.id,
      type: enemy.type,
      name: enemy.name,
      position: { ...enemy.position },
      facing: enemy.facing,
      health: enemy.health,
      maxHealth: enemy.maxHealth,
      alive: enemy.alive,
      hit: enemy.hitTicks > 0,
    }));
    this.send(this.peer?.socket, {
      type: 'sliceSnapshot',
      revision: this.level.revision,
      tick: this.tickNumber,
      complete: this.complete,
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
