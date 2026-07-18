export const KEY_BINDINGS = new Map([
  ['KeyW', 'up'], ['ArrowUp', 'up'],
  ['KeyS', 'down'], ['ArrowDown', 'down'],
  ['KeyA', 'left'], ['ArrowLeft', 'left'],
  ['KeyD', 'right'], ['ArrowRight', 'right'],
]);

export function updateInputFromKeyboard(event, eventName, input) {
  const action = KEY_BINDINGS.get(event.code);
  if (!action) return false;

  const editable = event.target?.closest?.('input, textarea, select, [contenteditable="true"]');
  if (editable) {
    if (eventName === 'keyup') input[action] = false;
    return false;
  }

  event.preventDefault();
  input[action] = eventName === 'keydown';
  return true;
}
