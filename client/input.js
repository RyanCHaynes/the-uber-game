export const KEY_BINDINGS = new Map([
  ['KeyW', 'up'], ['ArrowUp', 'up'],
  ['KeyS', 'down'], ['ArrowDown', 'down'],
  ['KeyA', 'left'], ['ArrowLeft', 'left'],
  ['KeyD', 'right'], ['ArrowRight', 'right'],
]);

export function updateInputFromKeyboard(event, eventName, input) {
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return false;

  const action = KEY_BINDINGS.get(event.code);
  if (!action) return false;

  event.preventDefault();
  input[action] = eventName === 'keydown';
  return true;
}
