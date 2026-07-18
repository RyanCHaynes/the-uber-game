const BINDINGS = Object.freeze({
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyW: 'jump',
  ArrowUp: 'jump',
  Space: 'attack',
});

export function actionForSliceCode(code) {
  return BINDINGS[code] || null;
}

export { BINDINGS as SLICE_BINDINGS };
