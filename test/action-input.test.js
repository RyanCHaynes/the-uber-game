import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActionInputController,
  DEFAULT_ACTION_BINDINGS,
  TOKEN_RUSH_ACTION_BINDINGS,
  compileActionBindings,
  createActionIntentPump,
} from '../client/action-input.js';

function keyboard(code, { editable = false } = {}) {
  let prevented = 0;
  return {
    code,
    target: { closest: () => (editable ? {} : null) },
    preventDefault: () => { prevented += 1; },
    get prevented() { return prevented; },
  };
}

test('campaign defaults map A/D, W/S, Space, and bounded action keys', () => {
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.left, ['KeyA', 'ArrowLeft']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.right, ['KeyD', 'ArrowRight']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.up, ['KeyW', 'ArrowUp']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.down, ['KeyS', 'ArrowDown']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.jump, ['Space']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.primary, ['KeyX']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.secondary, ['KeyC']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.interact, ['KeyE']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.dodge, ['ShiftLeft', 'ShiftRight']);
  assert.deepEqual(DEFAULT_ACTION_BINDINGS.pause, ['Escape']);
});

test('the accepted Token Rush profile keeps S and J inert while W jumps and Space attacks', () => {
  const controller = new ActionInputController({ bindings: TOKEN_RUSH_ACTION_BINDINGS });
  assert.equal(controller.actionForCode.get('KeyS'), undefined);
  assert.equal(controller.actionForCode.get('KeyJ'), undefined);
  assert.equal(controller.actionForCode.get('KeyW'), 'jump');
  assert.equal(controller.actionForCode.get('ArrowUp'), 'jump');
  assert.equal(controller.actionForCode.get('Space'), 'primary');
});

test('binding overrides are closed, finite, supported, and non-duplicated', () => {
  const custom = compileActionBindings({ primary: ['KeyF'], secondary: [] });
  assert.deepEqual(custom.primary, ['KeyF']);
  assert.deepEqual(custom.secondary, []);
  assert.throws(() => compileActionBindings({ fly: ['KeyF'] }), /Unknown action/);
  assert.throws(() => compileActionBindings({ primary: [] }), /requires at least one/);
  assert.throws(() => compileActionBindings({ primary: ['F13'] }), /Unsupported/);
  assert.throws(() => compileActionBindings({ primary: ['KeyA'] }), /Duplicate/);
  assert.throws(() => compileActionBindings({ dodge: ['KeyQ', 'KeyR', 'KeyT', 'KeyY', 'KeyU'] }), /0-4/);
});

test('editable fields never capture controls and clear held or pending actions', () => {
  const controller = new ActionInputController();
  const left = keyboard('KeyA');
  const attack = keyboard('KeyX');
  assert.equal(controller.handleKeyboard(left, 'keydown'), true);
  assert.equal(controller.handleKeyboard(attack, 'keydown'), true);
  assert.equal(controller.snapshot().held.left, true);
  assert.equal(controller.snapshot().pressed.primary, true);

  const typing = keyboard('KeyA', { editable: true });
  assert.equal(controller.handleKeyboard(typing, 'keydown'), false);
  assert.equal(typing.prevented, 0);
  assert.deepEqual(controller.snapshot(), {
    held: { left: false, right: false, up: false, down: false },
    pressed: { jump: false, primary: false, secondary: false, interact: false, dodge: false, pause: false },
  });
});

test('multiple keys for one held action release independently and repeats do not duplicate edges', () => {
  const controller = new ActionInputController();
  const a = keyboard('KeyA');
  const arrow = keyboard('ArrowLeft');
  controller.handleKeyboard(a, 'keydown');
  controller.handleKeyboard(arrow, 'keydown');
  controller.handleKeyboard(a, 'keyup');
  assert.equal(controller.snapshot().held.left, true);
  controller.handleKeyboard(arrow, 'keyup');
  assert.equal(controller.snapshot().held.left, false);

  const jump = keyboard('Space');
  controller.handleKeyboard(jump, 'keydown');
  controller.handleKeyboard(jump, 'keydown');
  assert.equal(controller.takeIntent(1).pressed.jump, true);
  assert.equal(controller.takeIntent(2).pressed.jump, false);
  controller.handleKeyboard(jump, 'keyup');
  controller.handleKeyboard(jump, 'keydown');
  assert.equal(controller.takeIntent(3).pressed.jump, true);
});

test('action pump sends at no more than 30 Hz, retains edges until send, and resets per transport', () => {
  let clock = 0;
  const sent = [];
  const controller = new ActionInputController();
  const pump = createActionIntentPump({ controller, send: (message) => sent.push(message), now: () => clock });

  assert.equal(pump.flush(), true);
  assert.equal(sent[0].sequence, 1);
  controller.handleKeyboard(keyboard('Space'), 'keydown');
  clock = 20;
  assert.equal(pump.flush(), false);
  assert.equal(controller.snapshot().pressed.jump, true);
  clock = 34;
  assert.equal(pump.flush(), true);
  assert.equal(sent[1].sequence, 2);
  assert.equal(sent[1].pressed.jump, true);
  assert.equal(controller.snapshot().pressed.jump, false);

  pump.reset();
  clock = 35;
  assert.equal(pump.flush(), true);
  assert.equal(sent[2].sequence, 1);
  assert.equal(pump.sequence, 1);
  assert.throws(() => createActionIntentPump({ controller, send() {}, maxHz: 31 }), /1-30/);
});
