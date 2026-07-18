import assert from 'node:assert/strict';
import test from 'node:test';

import { actionForSliceCode, SLICE_BINDINGS } from '../client/slice-input.js';

test('Token Rush maps WASD-compatible movement, W and up to jump, and Space to attack', () => {
  assert.equal(actionForSliceCode('KeyA'), 'left');
  assert.equal(actionForSliceCode('KeyD'), 'right');
  assert.equal(actionForSliceCode('ArrowLeft'), 'left');
  assert.equal(actionForSliceCode('ArrowRight'), 'right');
  assert.equal(actionForSliceCode('KeyW'), 'jump');
  assert.equal(actionForSliceCode('ArrowUp'), 'jump');
  assert.equal(actionForSliceCode('Space'), 'attack');
});

test('Token Rush leaves S and J unbound', () => {
  assert.equal(actionForSliceCode('KeyS'), null);
  assert.equal(actionForSliceCode('KeyJ'), null);
  assert.equal(Object.hasOwn(SLICE_BINDINGS, 'KeyS'), false);
  assert.equal(Object.hasOwn(SLICE_BINDINGS, 'KeyJ'), false);
});
