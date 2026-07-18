import assert from 'node:assert/strict';
import test from 'node:test';

import { updateInputFromKeyboard } from '../client/input.js';

function keyboardEvent(code, editable = false) {
  let prevented = false;
  return {
    code,
    target: { closest: () => (editable ? {} : null) },
    preventDefault: () => { prevented = true; },
    get prevented() { return prevented; },
  };
}

test('gameplay keys do not swallow letters while a name field is focused', () => {
  const input = { left: false };
  const event = keyboardEvent('KeyA', true);

  assert.equal(updateInputFromKeyboard(event, 'keydown', input), false);
  assert.equal(event.prevented, false);
  assert.equal(input.left, false);
});

test('gameplay keys still update and suppress browser defaults outside fields', () => {
  const input = { left: false };
  const down = keyboardEvent('KeyA');
  const up = keyboardEvent('KeyA');

  assert.equal(updateInputFromKeyboard(down, 'keydown', input), true);
  assert.equal(down.prevented, true);
  assert.equal(input.left, true);

  assert.equal(updateInputFromKeyboard(up, 'keyup', input), true);
  assert.equal(input.left, false);
});
