import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ACTION_MESSAGE_BYTES,
  MAX_ACTION_SEQUENCE,
  MAX_ACTION_SEQUENCE_GAP,
  neutralActionState,
  validateActionIntent,
} from '../shared/action-protocol.js';

function action(overrides = {}) {
  return {
    type: 'action',
    sequence: 1,
    held: { left: false, right: false, up: false, down: false },
    pressed: {
      jump: false,
      primary: false,
      secondary: false,
      interact: false,
      dodge: false,
      pause: false,
    },
    ...overrides,
  };
}

test('action protocol accepts only the exact normalized held and pressed shape', () => {
  const message = action({
    held: { left: true, right: false, up: true, down: false },
    pressed: { ...action().pressed, jump: true, primary: true },
  });
  const result = validateActionIntent(message, { byteLength: MAX_ACTION_MESSAGE_BYTES });
  assert.equal(result.ok, true);
  assert.deepEqual(result.intent, message);
  assert.equal(Object.isFrozen(result.intent), true);
  assert.equal(Object.isFrozen(result.intent.held), true);

  for (const malformed of [
    { ...message, x: 1 },
    { ...message, position: { x: 1, y: 2 } },
    { ...message, held: { ...message.held, fly: true } },
    { ...message, pressed: { ...message.pressed, damage: true } },
    { ...message, held: { ...message.held, left: 1 } },
    { ...message, pressed: [] },
  ]) {
    const rejected = validateActionIntent(malformed);
    assert.equal(rejected.ok, false);
  }
});

test('action protocol rejects stale, duplicate, discontinuous, and invalid sequences', () => {
  assert.equal(validateActionIntent(action({ sequence: 1 }), { lastSequence: 1 }).code, 'stale_action_sequence');
  assert.equal(validateActionIntent(action({ sequence: 9 }), { lastSequence: 10 }).code, 'stale_action_sequence');
  assert.equal(validateActionIntent(action({ sequence: 2 }), { lastSequence: 0 }).code, 'future_action_sequence');
  assert.equal(validateActionIntent(action({ sequence: 1 + MAX_ACTION_SEQUENCE_GAP }), { lastSequence: 1 }).ok, true);
  assert.equal(validateActionIntent(action({ sequence: 2 + MAX_ACTION_SEQUENCE_GAP }), { lastSequence: 1 }).code, 'future_action_sequence');
  assert.equal(validateActionIntent(action({ sequence: 0 })).code, 'invalid_action_sequence');
  assert.equal(validateActionIntent(action({ sequence: MAX_ACTION_SEQUENCE + 1 })).code, 'invalid_action_sequence');
  assert.equal(validateActionIntent(action({ sequence: 1.5 })).code, 'invalid_action_sequence');
});

test('action payload bytes are bounded before shape validation', () => {
  assert.equal(validateActionIntent(action(), { byteLength: MAX_ACTION_MESSAGE_BYTES }).ok, true);
  const result = validateActionIntent(action(), { byteLength: MAX_ACTION_MESSAGE_BYTES + 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'payload_too_large');
  assert.equal(validateActionIntent(action(), { byteLength: -1 }).code, 'invalid_payload_size');
});

test('neutral action state is closed, false, and immutable', () => {
  const state = neutralActionState();
  assert.deepEqual(state.held, { left: false, right: false, up: false, down: false });
  assert.deepEqual(state.pressed, {
    jump: false,
    primary: false,
    secondary: false,
    interact: false,
    dodge: false,
    pause: false,
  });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.pressed), true);
});
