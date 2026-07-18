export const ACTION_PROTOCOL = 'action-v1';
export const ACTION_MESSAGE_TYPE = 'action';
export const MAX_ACTION_MESSAGE_BYTES = 2048;
export const MAX_ACTION_SEQUENCE = 0xffff_ffff;
export const MAX_ACTION_SEQUENCE_GAP = 1024;
export const ACTION_INPUT_TIMEOUT_MS = 500;

export const HELD_ACTIONS = Object.freeze(['left', 'right', 'up', 'down']);
export const PRESSED_ACTIONS = Object.freeze([
  'jump',
  'primary',
  'secondary',
  'interact',
  'dodge',
  'pause',
]);

const MESSAGE_KEYS = Object.freeze(['type', 'sequence', 'held', 'pressed']);

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function isBooleanRecord(value, keys) {
  const sortedKeys = [...keys].sort();
  return hasExactKeys(value, sortedKeys) && keys.every((key) => typeof value[key] === 'boolean');
}

function rejected(code, reason) {
  return Object.freeze({ ok: false, code, reason });
}

export function neutralActionState() {
  return Object.freeze({
    held: Object.freeze(Object.fromEntries(HELD_ACTIONS.map((action) => [action, false]))),
    pressed: Object.freeze(Object.fromEntries(PRESSED_ACTIONS.map((action) => [action, false]))),
  });
}

export function validateActionIntent(message, {
  lastSequence = 0,
  byteLength = 0,
} = {}) {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    return rejected('invalid_payload_size', 'Invalid action payload size.');
  }
  if (byteLength > MAX_ACTION_MESSAGE_BYTES) {
    return rejected('payload_too_large', 'Action payload exceeds 2048 bytes.');
  }
  if (!hasExactKeys(message, [...MESSAGE_KEYS].sort())) {
    return rejected('invalid_action_shape', 'Action message fields are invalid.');
  }
  if (message.type !== ACTION_MESSAGE_TYPE) {
    return rejected('invalid_action_type', 'Action message type is invalid.');
  }
  if (!Number.isInteger(message.sequence) || message.sequence < 1 || message.sequence > MAX_ACTION_SEQUENCE) {
    return rejected('invalid_action_sequence', 'Action sequence is outside the supported range.');
  }
  if (!Number.isInteger(lastSequence) || lastSequence < 0 || lastSequence > MAX_ACTION_SEQUENCE) {
    return rejected('invalid_server_sequence', 'Server action sequence state is invalid.');
  }
  if (message.sequence <= lastSequence) {
    return rejected('stale_action_sequence', 'Action sequence is stale or duplicated.');
  }
  const sequenceGap = message.sequence - lastSequence;
  if ((lastSequence === 0 && message.sequence !== 1) || sequenceGap > MAX_ACTION_SEQUENCE_GAP) {
    return rejected('future_action_sequence', 'Action sequence is too far ahead.');
  }
  if (!isBooleanRecord(message.held, HELD_ACTIONS)) {
    return rejected('invalid_held_actions', 'Held actions must be the closed boolean set.');
  }
  if (!isBooleanRecord(message.pressed, PRESSED_ACTIONS)) {
    return rejected('invalid_pressed_actions', 'Pressed actions must be the closed boolean set.');
  }

  return Object.freeze({
    ok: true,
    intent: Object.freeze({
      type: ACTION_MESSAGE_TYPE,
      sequence: message.sequence,
      held: Object.freeze(Object.fromEntries(HELD_ACTIONS.map((action) => [action, message.held[action]]))),
      pressed: Object.freeze(Object.fromEntries(PRESSED_ACTIONS.map((action) => [action, message.pressed[action]]))),
    }),
  });
}
