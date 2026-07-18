const ENGINE = Object.freeze({
  gravity: 1450,
  maxHorizontalSpeed: 280,
  maxFallSpeed: 760,
  playerHalfWidth: 18,
  playerHalfHeight: 24,
  playerAttackReach: 64,
  playerAttackHeight: 58,
  playerInvulnerabilityTicks: 24,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
}

function overlaps(center, halfWidth, halfHeight, otherCenter, otherHalfWidth, otherHalfHeight) {
  return center.x + halfWidth > otherCenter.x - otherHalfWidth &&
    center.x - halfWidth < otherCenter.x + otherHalfWidth &&
    center.y + halfHeight > otherCenter.y - otherHalfHeight &&
    center.y - halfHeight < otherCenter.y + otherHalfHeight;
}

function flattenParts(part, parentId = null, depth = 0, target = new Map()) {
  const runtimePart = {
    id: part.id,
    name: part.name,
    parentId,
    depth,
    hp: part.hp,
    maxHp: part.hp,
    anchor: { ...part.anchor },
    size: { ...part.size },
    color: part.color,
    detachVelocity: part.detachVelocity ? { ...part.detachVelocity } : null,
    childPolicy: part.onDestroyed.children,
    alive: true,
    hitTicks: 0,
  };
  target.set(runtimePart.id, runtimePart);
  for (const child of part.children) flattenParts(child, runtimePart.id, depth + 1, target);
  return target;
}

function stateTable(controller) {
  return Object.fromEntries(controller.states.map((state) => [state.id, state]));
}

function controllerActive(entity, controller) {
  const owner = entity.partMap.get(controller.ownerPart);
  if (!entity.alive || !owner?.alive) return false;
  const isRoot = owner.id === entity.rootPartId;
  return controller.mode === 'root' ? isRoot : !isRoot;
}

function attackActive(entity, attack) {
  const owner = entity.partMap.get(attack.ownerPart);
  if (!entity.alive || !owner?.alive) return false;
  const isRoot = owner.id === entity.rootPartId;
  return attack.mode === 'always' || (attack.mode === 'root' ? isRoot : !isRoot);
}

export class TokenRushEnemyRuntime {
  constructor({ level, emitFeedback = () => {}, killPlayer = () => {} }) {
    this.level = level;
    this.emitFeedback = emitFeedback;
    this.killPlayer = killPlayer;
    this.detachSequence = 0;
    this.entities = level.enemies.map((enemy) => this.createEntity(enemy));
  }

  createEntity(levelEnemy, options = {}) {
    const definition = levelEnemy.definition;
    const partMap = options.partMap || flattenParts(definition.body);
    const rootPartId = options.rootPartId || definition.body.id;
    const entity = {
      id: options.id || levelEnemy.id,
      type: levelEnemy.type,
      name: options.name || definition.name,
      definition,
      rootPartId,
      partMap,
      position: { ...(options.position || levelEnemy.position) },
      velocity: { ...(options.velocity || { x: 0, y: 0 }) },
      facing: options.facing || -1,
      grounded: options.grounded ?? true,
      alive: true,
      detached: Boolean(options.detached),
      attackCooldown: 0,
      hitTicks: 0,
      controllerRuntime: new Map(),
      attackRuntime: new Map(),
    };
    Object.defineProperties(entity, {
      health: {
        enumerable: true,
        get() { return this.partMap.get(this.rootPartId)?.hp ?? 0; },
        set(value) {
          const root = this.partMap.get(this.rootPartId);
          if (root) root.hp = clamp(value, 0, root.maxHp);
        },
      },
      maxHealth: {
        enumerable: true,
        get() { return this.partMap.get(this.rootPartId)?.maxHp ?? 0; },
      },
    });
    return entity;
  }

  partPosition(entity, partId) {
    const part = entity.partMap.get(partId);
    if (!part) return { ...entity.position };
    let x = entity.position.x;
    let y = entity.position.y;
    let cursor = part;
    const seen = new Set();
    while (cursor && cursor.id !== entity.rootPartId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      x += cursor.anchor.x * entity.facing;
      y += cursor.anchor.y;
      cursor = cursor.parentId ? entity.partMap.get(cursor.parentId) : null;
    }
    return { x, y };
  }

  expressionContext(entity, ownerPartId, player, stateTicks = 0) {
    const owner = entity.partMap.get(ownerPartId) || entity.partMap.get(entity.rootPartId);
    const ownerPosition = this.partPosition(entity, owner?.id || entity.rootPartId);
    return { entity, owner, ownerPosition, player, stateTicks };
  }

  readNumeric(name, context) {
    const { entity, owner, ownerPosition, player, stateTicks } = context;
    const root = entity.partMap.get(entity.rootPartId);
    const values = {
      'target.dx': player.position.x - ownerPosition.x,
      'target.dy': player.position.y - ownerPosition.y,
      'target.distanceX': Math.abs(player.position.x - ownerPosition.x),
      'target.distanceY': Math.abs(player.position.y - ownerPosition.y),
      'self.x': entity.position.x,
      'self.y': entity.position.y,
      'self.velocityX': entity.velocity.x,
      'self.velocityY': entity.velocity.y,
      'self.health': root?.hp ?? 0,
      'self.healthFraction': root ? root.hp / root.maxHp : 0,
      'self.facing': entity.facing,
      'owner.hp': owner?.hp ?? 0,
      'owner.hpFraction': owner ? owner.hp / owner.maxHp : 0,
      'state.ticks': stateTicks,
    };
    if (name in values) return values[name];
    const match = /^parts\.([a-z0-9-]+)\.(hp|hpFraction)$/.exec(name);
    const part = match ? entity.partMap.get(match[1]) : null;
    if (!part?.alive) return 0;
    return match[2] === 'hp' ? part.hp : part.hp / part.maxHp;
  }

  evaluateNumber(expression, context) {
    if (typeof expression === 'number') return expression;
    if ('read' in expression) return this.readNumeric(expression.read, context);
    if (expression.op === 'abs') return Math.abs(this.evaluateNumber(expression.arg, context));
    if (expression.op === 'sign') return Math.sign(this.evaluateNumber(expression.arg, context));
    if (expression.op === 'neg') return -this.evaluateNumber(expression.arg, context);
    if (expression.op === 'clamp') {
      const minimum = this.evaluateNumber(expression.min, context);
      const maximum = this.evaluateNumber(expression.max, context);
      return clamp(this.evaluateNumber(expression.value, context), Math.min(minimum, maximum), Math.max(minimum, maximum));
    }
    const left = this.evaluateNumber(expression.args[0], context);
    const right = this.evaluateNumber(expression.args[1], context);
    if (expression.op === 'add') return left + right;
    if (expression.op === 'sub') return left - right;
    if (expression.op === 'mul') return left * right;
    if (expression.op === 'min') return Math.min(left, right);
    if (expression.op === 'max') return Math.max(left, right);
    return 0;
  }

  readBoolean(name, context) {
    const { entity, owner } = context;
    if (name === 'self.grounded') return entity.grounded;
    if (name === 'owner.alive') return Boolean(owner?.alive);
    if (name === 'owner.attached') return Boolean(owner?.alive && owner.id !== entity.rootPartId);
    const match = /^parts\.([a-z0-9-]+)\.(alive|attached)$/.exec(name);
    const part = match ? entity.partMap.get(match[1]) : null;
    if (!part?.alive) return false;
    return match[2] === 'alive' ? true : part.id !== entity.rootPartId;
  }

  evaluateCondition(condition, context) {
    if (typeof condition === 'boolean') return condition;
    if ('read' in condition) return this.readBoolean(condition.read, context);
    if (condition.op === 'all') return condition.args.every((item) => this.evaluateCondition(item, context));
    if (condition.op === 'any') return condition.args.some((item) => this.evaluateCondition(item, context));
    if (condition.op === 'not') return !this.evaluateCondition(condition.arg, context);
    const left = this.evaluateNumber(condition.args[0], context);
    const right = this.evaluateNumber(condition.args[1], context);
    if (condition.op === 'lt') return left < right;
    if (condition.op === 'lte') return left <= right;
    if (condition.op === 'gt') return left > right;
    if (condition.op === 'gte') return left >= right;
    return left === right;
  }

  applyAction(entity, ownerPartId, action, player, stateTicks = 0) {
    const owner = entity.partMap.get(ownerPartId);
    if (!owner?.alive) return;
    const context = this.expressionContext(entity, ownerPartId, player, stateTicks);
    if (action.op === 'motor.setVelocityX' && owner.id === entity.rootPartId) {
      entity.velocity.x = clamp(this.evaluateNumber(action.value, context), -ENGINE.maxHorizontalSpeed, ENGINE.maxHorizontalSpeed);
    } else if (action.op === 'motor.setVelocityY' && owner.id === entity.rootPartId) {
      entity.velocity.y = clamp(this.evaluateNumber(action.value, context), -600, ENGINE.maxFallSpeed);
      entity.grounded = false;
    } else if (action.op === 'motor.face' && owner.id === entity.rootPartId) {
      const direction = Math.sign(this.evaluateNumber(action.value, context));
      if (direction) entity.facing = direction;
    } else if (action.op === 'owner.setAnchorX' && owner.id !== entity.rootPartId) {
      owner.anchor.x = clamp(this.evaluateNumber(action.value, context), -96, 96);
    } else if (action.op === 'owner.setAnchorY' && owner.id !== entity.rootPartId) {
      owner.anchor.y = clamp(this.evaluateNumber(action.value, context), -96, 96);
    } else if (action.op === 'part.detach') {
      this.detachPart(entity, action.part, action.velocity);
    }
  }

  applyActions(entity, ownerPartId, actions, player, stateTicks = 0) {
    for (const item of actions) this.applyAction(entity, ownerPartId, item, player, stateTicks);
  }

  updateControllers(entity, player) {
    for (const controller of entity.definition.controllers) {
      if (!controllerActive(entity, controller)) continue;
      let runtime = entity.controllerRuntime.get(controller.id);
      if (!runtime) {
        runtime = { stateId: controller.initial, stateTicks: 0, entered: false };
        entity.controllerRuntime.set(controller.id, runtime);
      }
      const states = stateTable(controller);
      const state = states[runtime.stateId];
      if (!runtime.entered) {
        this.applyActions(entity, controller.ownerPart, state.enter, player, runtime.stateTicks);
        runtime.entered = true;
      }
      this.applyActions(entity, controller.ownerPart, state.tick, player, runtime.stateTicks);
      const context = this.expressionContext(entity, controller.ownerPart, player, runtime.stateTicks);
      const transition = state.transitions.find((candidate) => this.evaluateCondition(candidate.when, context));
      if (transition) {
        this.applyActions(entity, controller.ownerPart, transition.actions, player, runtime.stateTicks);
        runtime.stateId = transition.to;
        runtime.stateTicks = 0;
        runtime.entered = false;
      } else {
        runtime.stateTicks += 1;
      }
    }
  }

  moveEntity(entity, seconds) {
    if (!entity.alive) return;
    const root = entity.partMap.get(entity.rootPartId);
    if (!root?.alive) return;
    const halfWidth = root.size.w / 2;
    const halfHeight = root.size.h / 2;
    entity.velocity.y = Math.min(entity.velocity.y + ENGINE.gravity * seconds, ENGINE.maxFallSpeed);

    const deltaX = entity.velocity.x * seconds;
    let nextX = clamp(entity.position.x + deltaX, halfWidth, this.level.width - halfWidth);
    for (const solid of this.level.solids) {
      const verticallyOver = entity.position.y + halfHeight > solid.y && entity.position.y - halfHeight < solid.y + solid.height;
      if (!verticallyOver) continue;
      const right = solid.x + solid.width;
      if (deltaX > 0 && entity.position.x + halfWidth <= solid.x && nextX + halfWidth > solid.x) {
        nextX = solid.x - halfWidth;
        entity.velocity.x = 0;
      } else if (deltaX < 0 && entity.position.x - halfWidth >= right && nextX - halfWidth < right) {
        nextX = right + halfWidth;
        entity.velocity.x = 0;
      }
    }
    entity.position.x = nextX;

    const deltaY = entity.velocity.y * seconds;
    const previousTop = entity.position.y - halfHeight;
    const previousBottom = entity.position.y + halfHeight;
    let nextY = entity.position.y + deltaY;
    entity.grounded = false;
    if (deltaY >= 0) {
      let landingY = this.level.height;
      for (const solid of this.level.solids) {
        const horizontallyOver = entity.position.x + halfWidth > solid.x && entity.position.x - halfWidth < solid.x + solid.width;
        if (horizontallyOver && previousBottom <= solid.y && nextY + halfHeight >= solid.y) landingY = Math.min(landingY, solid.y);
      }
      if (nextY + halfHeight >= landingY) {
        nextY = landingY - halfHeight;
        entity.velocity.y = 0;
        entity.grounded = true;
      }
    } else {
      let ceilingY = -Infinity;
      for (const solid of this.level.solids) {
        const horizontallyOver = entity.position.x + halfWidth > solid.x && entity.position.x - halfWidth < solid.x + solid.width;
        const bottom = solid.y + solid.height;
        if (horizontallyOver && previousTop >= bottom && nextY - halfHeight <= bottom) ceilingY = Math.max(ceilingY, bottom);
      }
      if (ceilingY > -Infinity) {
        nextY = ceilingY + halfHeight;
        entity.velocity.y = 0;
      }
    }
    entity.position.y = nextY;
  }

  updateAttacks(entity, player) {
    if (entity.attackCooldown > 0) {
      entity.attackCooldown -= 1;
      return;
    }
    for (const attack of entity.definition.attacks) {
      let runtime = entity.attackRuntime.get(attack.id);
      if (!runtime) {
        runtime = { active: false, phaseIndex: 0, phaseTicks: 0, cooldown: 0, entered: false, hitKeys: new Set() };
        entity.attackRuntime.set(attack.id, runtime);
      }
      if (!attackActive(entity, attack)) {
        runtime.active = false;
        runtime.phaseIndex = 0;
        runtime.phaseTicks = 0;
        runtime.entered = false;
        runtime.hitKeys.clear();
        continue;
      }
      if (runtime.cooldown > 0) runtime.cooldown -= 1;
      if (!runtime.active) {
        if (runtime.cooldown > 0) continue;
        const context = this.expressionContext(entity, attack.ownerPart, player, 0);
        if (!this.evaluateCondition(attack.trigger, context)) continue;
        runtime.active = true;
        runtime.phaseIndex = 0;
        runtime.phaseTicks = 0;
        runtime.entered = false;
        runtime.hitKeys.clear();
      }
      const phase = attack.phases[runtime.phaseIndex];
      if (!runtime.entered) {
        this.applyActions(entity, attack.ownerPart, phase.enter, player, runtime.phaseTicks);
        runtime.entered = true;
      }
      this.applyHitVolumes(entity, attack, phase, runtime, player);
      runtime.phaseTicks += 1;
      if (runtime.phaseTicks >= phase.ticks) {
        runtime.phaseIndex += 1;
        runtime.phaseTicks = 0;
        runtime.entered = false;
        if (runtime.phaseIndex >= attack.phases.length) {
          runtime.active = false;
          runtime.phaseIndex = 0;
          runtime.cooldown = attack.cooldownTicks;
        }
      }
    }
  }

  applyHitVolumes(entity, attack, phase, runtime, player) {
    const owner = entity.partMap.get(attack.ownerPart);
    if (!owner?.alive) return;
    const ownerPosition = this.partPosition(entity, owner.id);
    phase.hitVolumes.forEach((volume, index) => {
      const key = `${runtime.phaseIndex}:${index}`;
      if (runtime.hitKeys.has(key)) return;
      const center = {
        x: ownerPosition.x + volume.offset.x * entity.facing,
        y: ownerPosition.y + volume.offset.y,
      };
      if (!overlaps(center, volume.size.w / 2, volume.size.h / 2, player.position, ENGINE.playerHalfWidth, ENGINE.playerHalfHeight)) return;
      runtime.hitKeys.add(key);
      if (player.invulnerabilityTicks > 0) return;
      player.invulnerabilityTicks = ENGINE.playerInvulnerabilityTicks;
      player.health = Math.max(0, player.health - volume.damage);
      player.velocity.x = volume.knockback.x * entity.facing;
      player.velocity.y = volume.knockback.y;
      if (player.health === 0) this.killPlayer(entity);
      else this.emitFeedback('playerHurt', `${owner.name} hits you`);
    });
  }

  update(seconds, player) {
    for (const entity of [...this.entities]) {
      if (!entity.alive) continue;
      if (entity.hitTicks > 0) entity.hitTicks -= 1;
      for (const part of entity.partMap.values()) if (part.hitTicks > 0) part.hitTicks -= 1;
      this.updateControllers(entity, player);
      this.moveEntity(entity, seconds);
      this.updateAttacks(entity, player);
      if (player.health === 0) break;
    }
  }

  descendants(entity, partId) {
    const ids = new Set([partId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const part of entity.partMap.values()) {
        if (!ids.has(part.id) && ids.has(part.parentId)) {
          ids.add(part.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  detachPart(entity, partId, velocity = null) {
    const root = entity.partMap.get(partId);
    if (!entity.alive || !root?.alive || partId === entity.rootPartId) return null;
    const position = this.partPosition(entity, partId);
    const ids = this.descendants(entity, partId);
    const partMap = new Map();
    for (const id of ids) {
      const part = entity.partMap.get(id);
      if (!part) continue;
      entity.partMap.delete(id);
      partMap.set(id, part);
    }
    root.parentId = null;
    root.anchor = { x: 0, y: 0 };
    const detachedVelocity = velocity || root.detachVelocity || { x: 0, y: 0 };
    const detached = this.createEntity({
      id: entity.id,
      type: entity.type,
      name: entity.definition.name,
      definition: entity.definition,
      position,
    }, {
      id: `${entity.id}~${partId}~${++this.detachSequence}`,
      name: root.name,
      rootPartId: partId,
      partMap,
      position,
      velocity: { x: detachedVelocity.x, y: detachedVelocity.y },
      facing: entity.facing,
      grounded: false,
      detached: true,
    });
    this.entities.push(detached);
    this.emitFeedback('enemyDetach', `${root.name} breaks free`);
    return detached;
  }

  destroySubtree(entity, partId) {
    for (const id of this.descendants(entity, partId)) {
      const part = entity.partMap.get(id);
      if (!part) continue;
      part.hp = 0;
      part.alive = false;
    }
  }

  destroyPart(entity, partId) {
    const part = entity.partMap.get(partId);
    if (!part?.alive) return;
    const children = [...entity.partMap.values()].filter((candidate) => candidate.alive && candidate.parentId === partId);
    if (part.childPolicy === 'detach') {
      for (const child of children) this.detachPart(entity, child.id, child.detachVelocity);
    } else {
      for (const child of children) this.destroySubtree(entity, child.id);
    }
    part.hp = 0;
    part.alive = false;
    if (partId === entity.rootPartId) {
      entity.alive = false;
      entity.velocity = { x: 0, y: 0 };
      this.emitFeedback('enemyDeath', `${entity.name} defeated`);
    } else {
      this.emitFeedback('enemyPartDestroyed', `${part.name} destroyed`);
    }
  }

  resolvePlayerAttack(player) {
    const center = {
      x: player.position.x + player.facing * (ENGINE.playerAttackReach / 2 + ENGINE.playerHalfWidth),
      y: player.position.y,
    };
    const targets = [];
    for (const entity of this.entities) {
      if (!entity.alive) continue;
      for (const part of entity.partMap.values()) {
        if (!part.alive) continue;
        const position = this.partPosition(entity, part.id);
        if (!overlaps(center, ENGINE.playerAttackReach / 2, ENGINE.playerAttackHeight / 2, position, part.size.w / 2, part.size.h / 2)) continue;
        const distance = Math.abs(position.x - player.position.x) + Math.abs(position.y - player.position.y);
        targets.push({ entity, part, distance });
      }
    }
    targets.sort((left, right) => left.distance - right.distance || right.part.depth - left.part.depth || left.part.id.localeCompare(right.part.id));
    const target = targets[0];
    if (!target) return null;
    target.part.hp = Math.max(0, target.part.hp - 1);
    target.part.hitTicks = 8;
    target.entity.hitTicks = 8;
    this.emitFeedback('enemyHit', `${target.part.name} -1`);
    if (target.part.hp === 0) this.destroyPart(target.entity, target.part.id);
    return { entityId: target.entity.id, partId: target.part.id };
  }

  snapshot() {
    return this.entities.map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      position: { ...entity.position },
      facing: entity.facing,
      health: entity.health,
      maxHealth: entity.maxHealth,
      alive: entity.alive,
      detached: entity.detached,
      hit: entity.hitTicks > 0,
      parts: [...entity.partMap.values()]
        .filter((part) => part.alive)
        .map((part) => ({
          id: part.id,
          name: part.name,
          parentId: part.parentId,
          position: this.partPosition(entity, part.id),
          size: { ...part.size },
          color: part.color,
          health: part.hp,
          maxHealth: part.maxHp,
          hit: part.hitTicks > 0,
          attached: part.id !== entity.rootPartId,
        })),
      attacks: entity.definition.attacks
        .map((attack) => ({ attack, runtime: entity.attackRuntime.get(attack.id) }))
        .filter(({ runtime }) => runtime?.active)
        .map(({ attack, runtime }) => ({ id: attack.id, ownerPart: attack.ownerPart, phase: attack.phases[runtime.phaseIndex]?.id || null })),
    }));
  }
}
