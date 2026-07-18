import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_RUSH_ENEMY_SCHEMA = 'token-rush-enemies/v2';
export const TOKEN_RUSH_ENEMY_MAX_BYTES = 64 * 1024;
export const TOKEN_RUSH_ENEMY_LIMITS = Object.freeze({
  enemies: 16,
  partsPerEnemy: 24,
  partDepth: 4,
  childrenPerPart: 6,
  controllersPerEnemy: 24,
  statesPerController: 32,
  actionsPerStep: 8,
  transitionsPerState: 8,
  attacksPerEnemy: 24,
  phasesPerAttack: 8,
  hitVolumesPerPhase: 4,
  expressionDepth: 8,
  expressionNodes: 32,
});

const CATALOG_KEYS = Object.freeze(['schema', 'revision', 'enemies']);
const ENEMY_KEYS = Object.freeze(['id', 'name', 'assetPack', 'body', 'controllers', 'attacks']);
const PART_KEYS = Object.freeze(['id', 'name', 'hp', 'anchor', 'size', 'color', 'detachVelocity', 'onDestroyed', 'children']);
const CONTROLLER_KEYS = Object.freeze(['id', 'ownerPart', 'mode', 'initial', 'states']);
const STATE_KEYS = Object.freeze(['id', 'enter', 'tick', 'transitions']);
const TRANSITION_KEYS = Object.freeze(['when', 'to', 'actions']);
const ATTACK_KEYS = Object.freeze(['id', 'ownerPart', 'mode', 'trigger', 'cooldownTicks', 'phases']);
const PHASE_KEYS = Object.freeze(['id', 'ticks', 'enter', 'hitVolumes']);
const HIT_VOLUME_KEYS = Object.freeze(['offset', 'size', 'damage', 'knockback']);
const NUMERIC_READS = new Set([
  'target.dx', 'target.dy', 'target.distanceX', 'target.distanceY',
  'self.x', 'self.y', 'self.velocityX', 'self.velocityY',
  'self.health', 'self.healthFraction', 'self.facing',
  'owner.hp', 'owner.hpFraction', 'state.ticks',
]);
const BOOLEAN_READS = new Set(['self.grounded', 'owner.alive', 'owner.attached']);
const BINARY_NUMERIC_OPS = new Set(['add', 'sub', 'mul', 'min', 'max']);
const COMPARISON_OPS = new Set(['lt', 'lte', 'gt', 'gte', 'eq']);

export class TokenRushEnemyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TokenRushEnemyError';
    this.code = code;
  }
}

function reject(code) {
  throw new TokenRushEnemyError(code);
}

function plainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) reject(code);
  return value;
}

function exactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject(code);
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject(code);
  return value;
}

function finiteNumber(value, minimum, maximum, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) reject(code);
  return Object.is(value, -0) ? 0 : value;
}

function slug(value, code) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) reject(code);
  return value;
}

function label(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 48 || /[^\x20-\x7e]/.test(value) || /\b(?:https?|javascript|data):|www\./i.test(value)) reject(code);
  return value;
}

function point(value, ranges, code) {
  plainObject(value, code);
  exactKeys(value, ['x', 'y'], code);
  return {
    x: finiteNumber(value.x, ranges.x[0], ranges.x[1], code),
    y: finiteNumber(value.y, ranges.y[0], ranges.y[1], code),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parsePart(value, context, parentId = null, depth = 1) {
  plainObject(value, 'ENEMY_PART_OBJECT');
  exactKeys(value, PART_KEYS, 'ENEMY_PART_KEYS');
  if (depth > TOKEN_RUSH_ENEMY_LIMITS.partDepth) reject('ENEMY_PART_DEPTH');
  const id = slug(value.id, 'ENEMY_PART_ID');
  if (context.parts.has(id)) reject('ENEMY_PART_DUPLICATE');
  if (context.parts.size >= TOKEN_RUSH_ENEMY_LIMITS.partsPerEnemy) reject('ENEMY_PART_COUNT');
  const anchor = point(value.anchor, { x: [-96, 96], y: [-96, 96] }, 'ENEMY_PART_ANCHOR');
  if (parentId === null && (anchor.x !== 0 || anchor.y !== 0)) reject('ENEMY_ROOT_ANCHOR');
  plainObject(value.size, 'ENEMY_PART_SIZE');
  exactKeys(value.size, ['w', 'h'], 'ENEMY_PART_SIZE');
  const size = {
    w: integer(value.size.w, 4, 96, 'ENEMY_PART_SIZE'),
    h: integer(value.size.h, 4, 96, 'ENEMY_PART_SIZE'),
  };
  if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/.test(value.color)) reject('ENEMY_PART_COLOR');
  const detachVelocity = value.detachVelocity === null
    ? null
    : point(value.detachVelocity, { x: [-280, 280], y: [-600, 600] }, 'ENEMY_PART_DETACH_VELOCITY');
  plainObject(value.onDestroyed, 'ENEMY_PART_DESTROY');
  exactKeys(value.onDestroyed, ['children'], 'ENEMY_PART_DESTROY');
  if (!['destroy', 'detach'].includes(value.onDestroyed.children)) reject('ENEMY_PART_DESTROY');
  if (!Array.isArray(value.children) || value.children.length > TOKEN_RUSH_ENEMY_LIMITS.childrenPerPart) reject('ENEMY_PART_CHILDREN');

  const part = {
    id,
    name: label(value.name, 'ENEMY_PART_NAME'),
    hp: integer(value.hp, 1, 50, 'ENEMY_PART_HP'),
    anchor,
    size,
    color: value.color,
    detachVelocity,
    onDestroyed: { children: value.onDestroyed.children },
    children: [],
  };
  context.parts.set(id, { part, parentId, depth });
  part.children = value.children.map((child) => parsePart(child, context, id, depth + 1));
  return part;
}

function numericExpression(value, context, budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > TOKEN_RUSH_ENEMY_LIMITS.expressionNodes || depth > TOKEN_RUSH_ENEMY_LIMITS.expressionDepth) reject('ENEMY_EXPRESSION_BUDGET');
  if (typeof value === 'number') return finiteNumber(value, -2048, 2048, 'ENEMY_EXPRESSION_NUMBER');
  plainObject(value, 'ENEMY_EXPRESSION_OBJECT');
  if ('read' in value) {
    exactKeys(value, ['read'], 'ENEMY_EXPRESSION_KEYS');
    if (typeof value.read !== 'string') reject('ENEMY_EXPRESSION_READ');
    const partMatch = /^parts\.([a-z0-9][a-z0-9-]{0,39})\.(hp|hpFraction)$/.exec(value.read);
    if (!NUMERIC_READS.has(value.read) && (!partMatch || !context.parts.has(partMatch[1]))) reject('ENEMY_EXPRESSION_READ');
    return { read: value.read };
  }
  if (typeof value.op !== 'string') reject('ENEMY_EXPRESSION_OP');
  if (BINARY_NUMERIC_OPS.has(value.op)) {
    exactKeys(value, ['op', 'args'], 'ENEMY_EXPRESSION_KEYS');
    if (!Array.isArray(value.args) || value.args.length !== 2) reject('ENEMY_EXPRESSION_ARGS');
    return { op: value.op, args: value.args.map((item) => numericExpression(item, context, budget, depth + 1)) };
  }
  if (['abs', 'sign', 'neg'].includes(value.op)) {
    exactKeys(value, ['op', 'arg'], 'ENEMY_EXPRESSION_KEYS');
    return { op: value.op, arg: numericExpression(value.arg, context, budget, depth + 1) };
  }
  if (value.op === 'clamp') {
    exactKeys(value, ['op', 'value', 'min', 'max'], 'ENEMY_EXPRESSION_KEYS');
    const minimum = numericExpression(value.min, context, budget, depth + 1);
    const maximum = numericExpression(value.max, context, budget, depth + 1);
    return { op: value.op, value: numericExpression(value.value, context, budget, depth + 1), min: minimum, max: maximum };
  }
  reject('ENEMY_EXPRESSION_OP');
}

function condition(value, context, budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > TOKEN_RUSH_ENEMY_LIMITS.expressionNodes || depth > TOKEN_RUSH_ENEMY_LIMITS.expressionDepth) reject('ENEMY_EXPRESSION_BUDGET');
  if (typeof value === 'boolean') return value;
  plainObject(value, 'ENEMY_CONDITION_OBJECT');
  if ('read' in value) {
    exactKeys(value, ['read'], 'ENEMY_CONDITION_KEYS');
    if (typeof value.read !== 'string') reject('ENEMY_CONDITION_READ');
    const partMatch = /^parts\.([a-z0-9][a-z0-9-]{0,39})\.(alive|attached)$/.exec(value.read);
    if (!BOOLEAN_READS.has(value.read) && (!partMatch || !context.parts.has(partMatch[1]))) reject('ENEMY_CONDITION_READ');
    return { read: value.read };
  }
  if (COMPARISON_OPS.has(value.op)) {
    exactKeys(value, ['op', 'args'], 'ENEMY_CONDITION_KEYS');
    if (!Array.isArray(value.args) || value.args.length !== 2) reject('ENEMY_CONDITION_ARGS');
    return { op: value.op, args: value.args.map((item) => numericExpression(item, context, budget, depth + 1)) };
  }
  if (['all', 'any'].includes(value.op)) {
    exactKeys(value, ['op', 'args'], 'ENEMY_CONDITION_KEYS');
    if (!Array.isArray(value.args) || value.args.length < 1 || value.args.length > 4) reject('ENEMY_CONDITION_ARGS');
    return { op: value.op, args: value.args.map((item) => condition(item, context, budget, depth + 1)) };
  }
  if (value.op === 'not') {
    exactKeys(value, ['op', 'arg'], 'ENEMY_CONDITION_KEYS');
    return { op: value.op, arg: condition(value.arg, context, budget, depth + 1) };
  }
  reject('ENEMY_CONDITION_OP');
}

function action(value, context, rootPartId) {
  plainObject(value, 'ENEMY_ACTION_OBJECT');
  if (['motor.setVelocityX', 'motor.setVelocityY', 'motor.face', 'owner.setAnchorX', 'owner.setAnchorY'].includes(value.op)) {
    exactKeys(value, ['op', 'value'], 'ENEMY_ACTION_KEYS');
    return { op: value.op, value: numericExpression(value.value, context) };
  }
  if (value.op === 'part.detach') {
    exactKeys(value, ['op', 'part', 'velocity'], 'ENEMY_ACTION_KEYS');
    const part = slug(value.part, 'ENEMY_ACTION_PART');
    if (part === rootPartId || !context.parts.has(part)) reject('ENEMY_ACTION_PART');
    return {
      op: value.op,
      part,
      velocity: point(value.velocity, { x: [-280, 280], y: [-600, 600] }, 'ENEMY_ACTION_VELOCITY'),
    };
  }
  reject('ENEMY_ACTION_OP');
}

function actions(value, context, rootPartId) {
  if (!Array.isArray(value) || value.length > TOKEN_RUSH_ENEMY_LIMITS.actionsPerStep) reject('ENEMY_ACTION_COUNT');
  return value.map((item) => action(item, context, rootPartId));
}

function parseController(value, context, rootPartId) {
  plainObject(value, 'ENEMY_CONTROLLER_OBJECT');
  exactKeys(value, CONTROLLER_KEYS, 'ENEMY_CONTROLLER_KEYS');
  const id = slug(value.id, 'ENEMY_CONTROLLER_ID');
  const ownerPart = slug(value.ownerPart, 'ENEMY_CONTROLLER_OWNER');
  if (!context.parts.has(ownerPart)) reject('ENEMY_CONTROLLER_OWNER');
  if (!['root', 'attached'].includes(value.mode)) reject('ENEMY_CONTROLLER_MODE');
  if (value.mode === 'attached' && ownerPart === rootPartId) reject('ENEMY_CONTROLLER_MODE');
  if (!Array.isArray(value.states) || value.states.length < 1 || value.states.length > TOKEN_RUSH_ENEMY_LIMITS.statesPerController) reject('ENEMY_CONTROLLER_STATES');
  const stateIds = new Set();
  const states = value.states.map((stateValue) => {
    plainObject(stateValue, 'ENEMY_STATE_OBJECT');
    exactKeys(stateValue, STATE_KEYS, 'ENEMY_STATE_KEYS');
    const stateId = slug(stateValue.id, 'ENEMY_STATE_ID');
    if (stateIds.has(stateId)) reject('ENEMY_STATE_DUPLICATE');
    stateIds.add(stateId);
    if (!Array.isArray(stateValue.transitions) || stateValue.transitions.length > TOKEN_RUSH_ENEMY_LIMITS.transitionsPerState) reject('ENEMY_TRANSITION_COUNT');
    return {
      id: stateId,
      enter: actions(stateValue.enter, context, rootPartId),
      tick: actions(stateValue.tick, context, rootPartId),
      transitions: stateValue.transitions.map((transitionValue) => {
        plainObject(transitionValue, 'ENEMY_TRANSITION_OBJECT');
        exactKeys(transitionValue, TRANSITION_KEYS, 'ENEMY_TRANSITION_KEYS');
        return {
          when: condition(transitionValue.when, context),
          to: slug(transitionValue.to, 'ENEMY_TRANSITION_TARGET'),
          actions: actions(transitionValue.actions, context, rootPartId),
        };
      }),
    };
  });
  const initial = slug(value.initial, 'ENEMY_CONTROLLER_INITIAL');
  if (!stateIds.has(initial)) reject('ENEMY_CONTROLLER_INITIAL');
  for (const state of states) {
    if (state.transitions.some((transition) => !stateIds.has(transition.to))) reject('ENEMY_TRANSITION_TARGET');
  }
  return { id, ownerPart, mode: value.mode, initial, states };
}

function parseAttack(value, context, rootPartId) {
  plainObject(value, 'ENEMY_ATTACK_OBJECT');
  exactKeys(value, ATTACK_KEYS, 'ENEMY_ATTACK_KEYS');
  const id = slug(value.id, 'ENEMY_ATTACK_ID');
  const ownerPart = slug(value.ownerPart, 'ENEMY_ATTACK_OWNER');
  if (!context.parts.has(ownerPart)) reject('ENEMY_ATTACK_OWNER');
  if (!['root', 'attached', 'always'].includes(value.mode)) reject('ENEMY_ATTACK_MODE');
  if (value.mode === 'attached' && ownerPart === rootPartId) reject('ENEMY_ATTACK_MODE');
  if (!Array.isArray(value.phases) || value.phases.length < 1 || value.phases.length > TOKEN_RUSH_ENEMY_LIMITS.phasesPerAttack) reject('ENEMY_ATTACK_PHASES');
  const phaseIds = new Set();
  let totalTicks = 0;
  const phases = value.phases.map((phaseValue) => {
    plainObject(phaseValue, 'ENEMY_ATTACK_PHASE_OBJECT');
    exactKeys(phaseValue, PHASE_KEYS, 'ENEMY_ATTACK_PHASE_KEYS');
    const phaseId = slug(phaseValue.id, 'ENEMY_ATTACK_PHASE_ID');
    if (phaseIds.has(phaseId)) reject('ENEMY_ATTACK_PHASE_DUPLICATE');
    phaseIds.add(phaseId);
    const ticks = integer(phaseValue.ticks, 1, 200, 'ENEMY_ATTACK_PHASE_TICKS');
    totalTicks += ticks;
    if (!Array.isArray(phaseValue.hitVolumes) || phaseValue.hitVolumes.length > TOKEN_RUSH_ENEMY_LIMITS.hitVolumesPerPhase) reject('ENEMY_ATTACK_HIT_VOLUMES');
    return {
      id: phaseId,
      ticks,
      enter: actions(phaseValue.enter, context, rootPartId),
      hitVolumes: phaseValue.hitVolumes.map((hitValue) => {
        plainObject(hitValue, 'ENEMY_HIT_VOLUME_OBJECT');
        exactKeys(hitValue, HIT_VOLUME_KEYS, 'ENEMY_HIT_VOLUME_KEYS');
        plainObject(hitValue.size, 'ENEMY_HIT_VOLUME_SIZE');
        exactKeys(hitValue.size, ['w', 'h'], 'ENEMY_HIT_VOLUME_SIZE');
        return {
          offset: point(hitValue.offset, { x: [-160, 160], y: [-160, 160] }, 'ENEMY_HIT_VOLUME_OFFSET'),
          size: {
            w: integer(hitValue.size.w, 1, 160, 'ENEMY_HIT_VOLUME_SIZE'),
            h: integer(hitValue.size.h, 1, 160, 'ENEMY_HIT_VOLUME_SIZE'),
          },
          damage: integer(hitValue.damage, 1, 3, 'ENEMY_HIT_VOLUME_DAMAGE'),
          knockback: point(hitValue.knockback, { x: [-280, 280], y: [-600, 600] }, 'ENEMY_HIT_VOLUME_KNOCKBACK'),
        };
      }),
    };
  });
  if (totalTicks > 300) reject('ENEMY_ATTACK_TICK_BUDGET');
  return {
    id,
    ownerPart,
    mode: value.mode,
    trigger: condition(value.trigger, context),
    cooldownTicks: integer(value.cooldownTicks, 0, 300, 'ENEMY_ATTACK_COOLDOWN'),
    phases,
  };
}

export function validateTokenRushEnemyCatalog(document) {
  plainObject(document, 'ENEMY_CATALOG_OBJECT');
  exactKeys(document, CATALOG_KEYS, 'ENEMY_CATALOG_KEYS');
  if (document.schema !== TOKEN_RUSH_ENEMY_SCHEMA) reject('ENEMY_CATALOG_SCHEMA');
  const authoredRevision = slug(document.revision, 'ENEMY_CATALOG_REVISION');
  if (!Array.isArray(document.enemies) || document.enemies.length < 1 || document.enemies.length > TOKEN_RUSH_ENEMY_LIMITS.enemies) reject('ENEMY_DEFINITION_COUNT');
  const enemyIds = new Set();
  const enemies = document.enemies.map((enemyValue) => {
    plainObject(enemyValue, 'ENEMY_DEFINITION_OBJECT');
    exactKeys(enemyValue, ENEMY_KEYS, 'ENEMY_DEFINITION_KEYS');
    const id = slug(enemyValue.id, 'ENEMY_DEFINITION_ID');
    if (enemyIds.has(id)) reject('ENEMY_DEFINITION_DUPLICATE');
    enemyIds.add(id);
    const context = { parts: new Map() };
    const body = parsePart(enemyValue.body, context);
    if (!Array.isArray(enemyValue.controllers) || enemyValue.controllers.length < 1 || enemyValue.controllers.length > TOKEN_RUSH_ENEMY_LIMITS.controllersPerEnemy) reject('ENEMY_CONTROLLER_COUNT');
    const controllerIds = new Set();
    const controllers = enemyValue.controllers.map((controllerValue) => {
      const controller = parseController(controllerValue, context, body.id);
      if (controllerIds.has(controller.id)) reject('ENEMY_CONTROLLER_DUPLICATE');
      controllerIds.add(controller.id);
      return controller;
    });
    if (!controllers.some((controller) => controller.ownerPart === body.id && controller.mode === 'root')) reject('ENEMY_ROOT_CONTROLLER');
    if (!Array.isArray(enemyValue.attacks) || enemyValue.attacks.length > TOKEN_RUSH_ENEMY_LIMITS.attacksPerEnemy) reject('ENEMY_ATTACK_COUNT');
    const attackIds = new Set();
    const attacks = enemyValue.attacks.map((attackValue) => {
      const attack = parseAttack(attackValue, context, body.id);
      if (attackIds.has(attack.id)) reject('ENEMY_ATTACK_DUPLICATE');
      attackIds.add(attack.id);
      return attack;
    });
    return {
      id,
      name: label(enemyValue.name, 'ENEMY_DEFINITION_NAME'),
      assetPack: slug(enemyValue.assetPack, 'ENEMY_DEFINITION_ASSET'),
      body,
      controllers,
      attacks,
    };
  });
  const normalized = { schema: TOKEN_RUSH_ENEMY_SCHEMA, revision: authoredRevision, enemies };
  const sha256 = contentHash(normalized);
  return deepFreeze({
    ...normalized,
    revision: `${authoredRevision}@${sha256.slice(0, 12)}`,
    authoredRevision,
    sha256,
    byId: Object.fromEntries(enemies.map((enemy) => [enemy.id, enemy])),
  });
}

function legacyEnemy(id, name, hp, speed, color) {
  const distanceClose = { op: 'all', args: [
    { op: 'lte', args: [{ read: 'target.distanceX' }, 46] },
    { op: 'lte', args: [{ read: 'target.distanceY' }, 58] },
  ] };
  return {
    id,
    name,
    assetPack: id,
    body: {
      id: 'body', name, hp,
      anchor: { x: 0, y: 0 }, size: { w: 44, h: 56 }, color,
      detachVelocity: null, onDestroyed: { children: 'destroy' }, children: [],
    },
    controllers: [{
      id: 'locomotion', ownerPart: 'body', mode: 'root', initial: 'pursue',
      states: [
        {
          id: 'idle', enter: [], tick: [{ op: 'motor.setVelocityX', value: 0 }],
          transitions: [{ when: { op: 'lte', args: [{ read: 'target.distanceX' }, 300] }, to: 'pursue', actions: [] }],
        },
        {
          id: 'pursue', enter: [], tick: [
            { op: 'motor.setVelocityX', value: { op: 'mul', args: [{ op: 'sign', arg: { read: 'target.dx' } }, speed] } },
            { op: 'motor.face', value: { op: 'sign', arg: { read: 'target.dx' } } },
          ],
          transitions: [
            { when: { op: 'lte', args: [{ read: 'target.distanceX' }, 42] }, to: 'hold', actions: [] },
            { when: { op: 'gt', args: [{ read: 'target.distanceX' }, 300] }, to: 'idle', actions: [] },
          ],
        },
        {
          id: 'hold', enter: [], tick: [{ op: 'motor.setVelocityX', value: 0 }],
          transitions: [{ when: { op: 'gt', args: [{ read: 'target.distanceX' }, 46] }, to: 'pursue', actions: [] }],
        },
      ],
    }],
    attacks: [{
      id: 'strike', ownerPart: 'body', mode: 'root', trigger: distanceClose, cooldownTicks: 0,
      phases: [
        { id: 'active', ticks: 1, enter: [{ op: 'motor.setVelocityX', value: 0 }], hitVolumes: [{ offset: { x: 24, y: 0 }, size: { w: 48, h: 58 }, damage: 1, knockback: { x: 70, y: -40 } }] },
        { id: 'recovery', ticks: 41, enter: [], hitVolumes: [] },
      ],
    }],
  };
}

export const FALLBACK_TOKEN_RUSH_ENEMY_DOCUMENT = deepFreeze({
  schema: TOKEN_RUSH_ENEMY_SCHEMA,
  revision: 'crypt-enemies-fallback',
  enemies: [
    legacyEnemy('crawler', 'Crypt Crawler', 1, 78, '#7b496e'),
    legacyEnemy('guard', 'Crypt Guard', 2, 52, '#7a4663'),
    legacyEnemy('warden', 'Crypt Warden', 3, 58, '#9d3448'),
  ],
});
export const FALLBACK_TOKEN_RUSH_ENEMY_CATALOG = validateTokenRushEnemyCatalog(FALLBACK_TOKEN_RUSH_ENEMY_DOCUMENT);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOKEN_RUSH_ENEMY_FILE = path.resolve(moduleDirectory, '../content/token-rush-enemies.json');

export function loadTokenRushEnemyCatalogFile(file = DEFAULT_TOKEN_RUSH_ENEMY_FILE) {
  try {
    const details = statSync(file);
    if (!details.isFile() || details.size < 2 || details.size > TOKEN_RUSH_ENEMY_MAX_BYTES) reject('ENEMY_FILE_SIZE');
    const bytes = readFileSync(file);
    if (bytes.length !== details.size) reject('ENEMY_FILE_CHANGED');
    let document;
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      reject('ENEMY_FILE_JSON');
    }
    return Object.freeze({ catalog: validateTokenRushEnemyCatalog(document), source: 'file', rejectionCode: null });
  } catch (error) {
    const rejectionCode = error instanceof TokenRushEnemyError ? error.code : 'ENEMY_FILE_READ';
    return Object.freeze({ catalog: FALLBACK_TOKEN_RUSH_ENEMY_CATALOG, source: 'fallback', rejectionCode });
  }
}
