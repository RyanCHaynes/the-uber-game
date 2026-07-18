const SLICE = Object.freeze({
  revision: 'solo-slice-v1',
  width: 1600,
  height: 720,
  floorY: 640,
  tickRate: 50,
  snapshotRate: 20,
  playerSpeed: 245,
  gravity: 1450,
  jumpSpeed: 570,
  playerHalfWidth: 18,
  playerHalfHeight: 24,
  enemyHalfWidth: 22,
  enemyHalfHeight: 28,
  attackRange: 72,
  attackCooldownTicks: 16,
  enemyAttackCooldownTicks: 42,
  obstacles: Object.freeze([
    Object.freeze({ x: 250, width: 34, height: 52 }),
    Object.freeze({ x: 490, width: 34, height: 52 }),
    Object.freeze({ x: 730, width: 34, height: 52 }),
    Object.freeze({ x: 970, width: 34, height: 52 }),
    Object.freeze({ x: 1210, width: 34, height: 52 }),
  ]),
});

function cleanName(value) {
  const printable = String(value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 18);
  return printable || 'Player';
}

function overlapsVertically(positionY, halfHeight, top, bottom) {
  return positionY + halfHeight > top && positionY - halfHeight < bottom;
}

export class SoloSliceRoom {
  constructor({ now = Date.now } = {}) {
    this.now = now;
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
      position: { x: 82, y: SLICE.floorY - SLICE.playerHalfHeight },
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
    this.enemy = {
      id: 'crypt-warden',
      name: 'Crypt Warden',
      position: { x: 1480, y: SLICE.floorY - SLICE.enemyHalfHeight },
      health: 3,
      maxHealth: 3,
      alive: true,
      facing: -1,
      attackCooldown: 0,
      hitTicks: 0,
    };
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
      this.send(socket, { type: 'sliceWelcome', id: this.player.id, revision: SLICE.revision });
      this.send(socket, { type: 'sliceStart', level: this.levelPayload() });
      this.emitFeedback('notice', 'Five barriers. One warden. Make every hit count.');
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
      this.updateEnemy(elapsed);
      this.tickNumber += 1;
    }
    this.snapshotElapsed += elapsed;
    if (this.snapshotElapsed >= 1 / SLICE.snapshotRate) {
      this.snapshotElapsed = 0;
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
      this.emitFeedback('jump', `Jump ${player.jumpCount}`);
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
    let nextX = Math.max(SLICE.playerHalfWidth, Math.min(SLICE.width - SLICE.playerHalfWidth, player.position.x + deltaX));
    for (const obstacle of SLICE.obstacles) {
      const top = SLICE.floorY - obstacle.height;
      if (!overlapsVertically(player.position.y, SLICE.playerHalfHeight, top, SLICE.floorY)) continue;
      const left = obstacle.x;
      const right = obstacle.x + obstacle.width;
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
    const previousBottom = player.position.y + SLICE.playerHalfHeight;
    let nextY = player.position.y + deltaY;
    player.grounded = false;
    if (deltaY >= 0) {
      let landingY = SLICE.floorY;
      for (const obstacle of SLICE.obstacles) {
        const horizontallyOver = player.position.x + SLICE.playerHalfWidth > obstacle.x &&
          player.position.x - SLICE.playerHalfWidth < obstacle.x + obstacle.width;
        const top = SLICE.floorY - obstacle.height;
        if (horizontallyOver && previousBottom <= top && nextY + SLICE.playerHalfHeight >= top) {
          landingY = Math.min(landingY, top);
        }
      }
      if (nextY + SLICE.playerHalfHeight >= landingY) {
        nextY = landingY - SLICE.playerHalfHeight;
        player.velocity.y = 0;
        player.grounded = true;
      }
    }
    player.position.y = nextY;
  }

  resolvePlayerAttack() {
    const player = this.player;
    const enemy = this.enemy;
    if (!enemy.alive) return;
    const dx = enemy.position.x - player.position.x;
    const inFront = Math.sign(dx || player.facing) === player.facing;
    if (!inFront || Math.abs(dx) > SLICE.attackRange || Math.abs(enemy.position.y - player.position.y) > 58) return;
    enemy.health -= 1;
    enemy.hitTicks = 8;
    this.emitFeedback('enemyHit', `${enemy.name} -1`);
    if (enemy.health <= 0) {
      enemy.health = 0;
      enemy.alive = false;
      this.emitFeedback('enemyDeath', `${enemy.name} defeated`);
      this.complete = true;
      this.emitFeedback('complete', `Slice complete in ${player.jumpCount} jumps.`);
    }
  }

  updateEnemy(seconds) {
    const enemy = this.enemy;
    const player = this.player;
    if (!enemy.alive) return;
    if (enemy.hitTicks > 0) enemy.hitTicks -= 1;
    if (enemy.attackCooldown > 0) enemy.attackCooldown -= 1;
    const dx = player.position.x - enemy.position.x;
    enemy.facing = dx < 0 ? -1 : 1;
    if (Math.abs(dx) < 300 && Math.abs(dx) > 42) {
      enemy.position.x += Math.sign(dx) * 58 * seconds;
      enemy.position.x = Math.max(1320, Math.min(1538, enemy.position.x));
    }
    if (Math.abs(dx) <= 46 && enemy.attackCooldown === 0 && player.invulnerabilityTicks === 0) {
      enemy.attackCooldown = SLICE.enemyAttackCooldownTicks;
      player.invulnerabilityTicks = 24;
      player.health = Math.max(1, player.health - 1);
      this.emitFeedback('playerHurt', `${enemy.name} hits you`);
    }
  }

  emitFeedback(type, text) {
    this.feedback.push({ id: ++this.eventSequence, tick: this.tickNumber, type, text });
    if (this.feedback.length > 24) this.feedback.shift();
  }

  levelPayload() {
    return {
      revision: SLICE.revision,
      width: SLICE.width,
      height: SLICE.height,
      floorY: SLICE.floorY,
      obstacles: SLICE.obstacles.map((obstacle) => ({ ...obstacle })),
      intendedJumpCount: SLICE.obstacles.length,
      enemy: { id: this.enemy.id, name: this.enemy.name },
    };
  }

  broadcastSnapshot() {
    this.send(this.peer?.socket, {
      type: 'sliceSnapshot',
      revision: SLICE.revision,
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
      enemy: {
        id: this.enemy.id,
        name: this.enemy.name,
        position: { ...this.enemy.position },
        facing: this.enemy.facing,
        health: this.enemy.health,
        maxHealth: this.enemy.maxHealth,
        alive: this.enemy.alive,
        hit: this.enemy.hitTicks > 0,
      },
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
