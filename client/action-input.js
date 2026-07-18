import {
  ACTION_MESSAGE_TYPE,
  HELD_ACTIONS,
  MAX_ACTION_SEQUENCE,
  PRESSED_ACTIONS,
} from '../shared/action-protocol.js';

export const ACTIONS = Object.freeze([...HELD_ACTIONS, ...PRESSED_ACTIONS]);
export const MAX_BINDINGS_PER_ACTION = 4;
export const MAX_ACTION_SEND_HZ = 30;

export const SUPPORTED_KEY_CODES = Object.freeze([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Enter', 'Escape', 'Tab',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  ...Array.from({ length: 26 }, (_unused, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_unused, index) => `Digit${index}`),
  'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal',
]);

const supportedCodes = new Set(SUPPORTED_KEY_CODES);
const heldActionSet = new Set(HELD_ACTIONS);
const pressedActionSet = new Set(PRESSED_ACTIONS);

function freezeBindings(bindings) {
  return Object.freeze(Object.fromEntries(
    ACTIONS.map((action) => [action, Object.freeze([...bindings[action]])]),
  ));
}

export const DEFAULT_ACTION_BINDINGS = freezeBindings({
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  jump: ['Space'],
  primary: ['KeyX'],
  secondary: ['KeyC'],
  interact: ['KeyE'],
  dodge: ['ShiftLeft', 'ShiftRight'],
  pause: ['Escape'],
});

export const TOKEN_RUSH_ACTION_BINDINGS = freezeBindings({
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: [],
  down: [],
  jump: ['KeyW', 'ArrowUp'],
  primary: ['Space'],
  secondary: [],
  interact: [],
  dodge: [],
  pause: ['Escape'],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function compileActionBindings(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('Action binding overrides must be an object.');
  for (const action of Object.keys(overrides)) {
    if (!ACTIONS.includes(action)) throw new TypeError(`Unknown action binding: ${action}.`);
  }

  const result = {};
  const claimedCodes = new Set();
  for (const action of ACTIONS) {
    const codes = Object.hasOwn(overrides, action) ? overrides[action] : DEFAULT_ACTION_BINDINGS[action];
    if (!Array.isArray(codes) || codes.length > MAX_BINDINGS_PER_ACTION) {
      throw new TypeError(`${action} must have 0-${MAX_BINDINGS_PER_ACTION} key codes.`);
    }
    const unique = new Set();
    for (const code of codes) {
      if (typeof code !== 'string' || !supportedCodes.has(code)) {
        throw new TypeError(`Unsupported key code for ${action}.`);
      }
      if (unique.has(code) || claimedCodes.has(code)) {
        throw new TypeError(`Duplicate key code: ${code}.`);
      }
      unique.add(code);
      claimedCodes.add(code);
    }
    result[action] = [...unique];
  }

  for (const required of ['left', 'right', 'jump', 'primary']) {
    if (result[required].length === 0) throw new TypeError(`${required} requires at least one binding.`);
  }
  return freezeBindings(result);
}

export function isEditableTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

function emptyBooleanRecord(actions) {
  return Object.fromEntries(actions.map((action) => [action, false]));
}

export class ActionInputController {
  constructor({ bindings = DEFAULT_ACTION_BINDINGS } = {}) {
    this.bindings = compileActionBindings(bindings);
    this.actionForCode = new Map();
    for (const action of ACTIONS) {
      for (const code of this.bindings[action]) this.actionForCode.set(code, action);
    }
    this.heldCodes = new Set();
    this.pressed = new Set();
  }

  handleKeyboard(event, eventName) {
    if (eventName !== 'keydown' && eventName !== 'keyup') return false;
    if (isEditableTarget(event?.target)) {
      this.clear();
      return false;
    }
    const action = this.actionForCode.get(event?.code);
    if (!action) return false;

    event.preventDefault?.();
    if (eventName === 'keydown') {
      if (this.heldCodes.has(event.code)) return true;
      this.heldCodes.add(event.code);
      if (pressedActionSet.has(action)) this.pressed.add(action);
      return true;
    }

    this.heldCodes.delete(event.code);
    return true;
  }

  clear() {
    this.heldCodes.clear();
    this.pressed.clear();
  }

  snapshot() {
    const held = emptyBooleanRecord(HELD_ACTIONS);
    for (const code of this.heldCodes) {
      const action = this.actionForCode.get(code);
      if (heldActionSet.has(action)) held[action] = true;
    }
    const pressed = emptyBooleanRecord(PRESSED_ACTIONS);
    for (const action of this.pressed) pressed[action] = true;
    return Object.freeze({ held: Object.freeze(held), pressed: Object.freeze(pressed) });
  }

  takeIntent(sequence) {
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_ACTION_SEQUENCE) {
      throw new RangeError('Action sequence is outside the supported range.');
    }
    const { held, pressed } = this.snapshot();
    this.pressed.clear();
    return Object.freeze({ type: ACTION_MESSAGE_TYPE, sequence, held, pressed });
  }
}

export function createActionIntentPump({
  controller,
  send,
  now = () => performance.now(),
  maxHz = MAX_ACTION_SEND_HZ,
} = {}) {
  if (!(controller instanceof ActionInputController)) throw new TypeError('Action controller is required.');
  if (typeof send !== 'function' || typeof now !== 'function') throw new TypeError('Action send and clock functions are required.');
  if (!Number.isInteger(maxHz) || maxHz < 1 || maxHz > MAX_ACTION_SEND_HZ) {
    throw new RangeError(`Action send rate must be 1-${MAX_ACTION_SEND_HZ} Hz.`);
  }

  const minimumIntervalMs = 1000 / maxHz;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let sequence = 0;

  return Object.freeze({
    flush() {
      const current = Number(now());
      if (!Number.isFinite(current) || current < lastSentAt) return false;
      if (current - lastSentAt < minimumIntervalMs) return false;
      if (sequence >= MAX_ACTION_SEQUENCE) throw new RangeError('Action sequence exhausted.');
      sequence += 1;
      send(controller.takeIntent(sequence));
      lastSentAt = current;
      return true;
    },
    clear() {
      controller.clear();
    },
    reset() {
      controller.clear();
      sequence = 0;
      lastSentAt = Number.NEGATIVE_INFINITY;
    },
    get sequence() {
      return sequence;
    },
    get minimumIntervalMs() {
      return minimumIntervalMs;
    },
  });
}
