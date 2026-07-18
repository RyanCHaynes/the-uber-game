import './slice-style.css';
import { actionForSliceCode } from './slice-input.js';

const elements = Object.fromEntries([
  'game-canvas', 'setup', 'player-name', 'play-button', 'hud', 'health',
  'enemy-health', 'feedback', 'complete', 'result-title', 'complete-text', 'again-button', 'error',
  'error-text', 'retry-button', 'legend',
].map((id) => [id, document.getElementById(id)]));

const canvas = elements['game-canvas'];
const context = canvas.getContext('2d', { alpha: false });
const input = { left: false, right: false, jump: false, attack: false };
const INTERPOLATION_DELAY_MS = 120;
let socket = null;
let sequence = 0;
let intentionalClose = false;
let level = null;
let snapshot = null;
let renderSamples = [];
let lastFeedbackId = 0;
let feedbackTimer = null;

function websocketUrl() {
  const url = new URL('/slice-ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function show(name) {
  elements.setup.classList.toggle('hidden', name !== 'setup');
  elements.error.classList.toggle('hidden', name !== 'error');
  const playing = name === 'game';
  elements.hud.classList.toggle('hidden', !playing);
  elements.legend.classList.toggle('hidden', !playing);
  if (!playing) elements.complete.classList.add('hidden');
}

function connect() {
  const name = elements['player-name'].value.trim().slice(0, 18) || 'Player';
  localStorage.setItem('coinrush-slice-name', name);
  elements['play-button'].disabled = true;
  elements['play-button'].textContent = 'OPENING TOKEN RUSH…';
  intentionalClose = false;
  socket = new WebSocket(websocketUrl());
  socket.addEventListener('open', () => send({ type: 'hello', name }));
  socket.addEventListener('message', ({ data }) => {
    try {
      handleMessage(JSON.parse(data));
    } catch (error) {
      fail(`Invalid authoritative data: ${error.message}`);
    }
  });
  socket.addEventListener('close', ({ code, reason }) => {
    if (!intentionalClose) fail(reason || `The server closed the connection (${code}).`);
  });
  socket.addEventListener('error', () => {
    if (socket?.readyState !== WebSocket.OPEN) fail('Could not reach the solo preview.');
  });
}

function handleMessage(message) {
  if (!message || typeof message.type !== 'string') throw new Error('missing message type');
  if (message.type === 'sliceWelcome') return;
  if (message.type === 'sliceStart') {
    if (!message.level || message.level.schema !== 'token-rush-level/v1' ||
        typeof message.level.revision !== 'string') throw new Error('level contract mismatch');
    level = message.level;
    snapshot = null;
    renderSamples = [];
    clearInput();
    elements.complete.classList.add('hidden');
    elements['again-button'].disabled = false;
    show('game');
    return;
  }
  if (message.type === 'sliceSnapshot') {
    if (!level || message.revision !== level.revision) throw new Error('snapshot revision mismatch');
    snapshot = message;
    recordRenderSample(message);
    renderHud();
    consumeFeedback(message.feedback || []);
    if (message.dead) {
      clearInput();
      elements['result-title'].textContent = 'YOU DIED';
      elements['complete-text'].textContent = 'The crypt got you. Restart this level and try again.';
      elements['again-button'].textContent = 'RESTART LEVEL';
      elements.complete.classList.remove('hidden');
    } else if (message.complete) {
      clearInput();
      elements['result-title'].textContent = 'CRYPT CLEARED';
      elements['complete-text'].textContent = 'You reached the crypt gate. Token Rush is complete.';
      elements['again-button'].textContent = 'PLAY AGAIN';
      elements.complete.classList.remove('hidden');
    } else {
      elements.complete.classList.add('hidden');
    }
    return;
  }
  if (message.type === 'sliceNotice') {
    showFeedback({ type: 'notice', text: String(message.text || '').slice(0, 160) });
    return;
  }
  throw new Error(`unknown message type ${message.type}`);
}

function recordRenderSample(message) {
  if (!Number.isSafeInteger(message.tick) || !message.player?.position) return;
  renderSamples.push({
    tick: message.tick,
    receivedAt: performance.now(),
    player: { ...message.player.position },
  });
  if (renderSamples.length > 12) renderSamples.shift();
}

function renderedPosition(entity, now) {
  const authoritative = snapshot?.[entity]?.position;
  if (!authoritative || renderSamples.length < 2) return authoritative;
  const renderAt = now - INTERPOLATION_DELAY_MS;
  let before = null;
  let after = null;
  for (const sample of renderSamples) {
    if (sample.receivedAt <= renderAt) before = sample;
    if (sample.receivedAt >= renderAt) {
      after = sample;
      break;
    }
  }
  if (!before) return renderSamples[0][entity];
  if (!after || after.receivedAt === before.receivedAt) return before[entity];
  const amount = Math.max(0, Math.min(1,
    (renderAt - before.receivedAt) / (after.receivedAt - before.receivedAt)));
  return {
    x: before[entity].x + (after[entity].x - before[entity].x) * amount,
    y: before[entity].y + (after[entity].y - before[entity].y) * amount,
  };
}

function consumeFeedback(events) {
  for (const event of events) {
    if (!Number.isSafeInteger(event.id) || event.id <= lastFeedbackId) continue;
    lastFeedbackId = event.id;
    showFeedback(event);
  }
}

function showFeedback(event) {
  const text = String(event.text || '').slice(0, 100);
  elements.feedback.textContent = text;
  elements.feedback.className = `feedback ${event.type || 'notice'}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => elements.feedback.classList.add('hidden'), event.type === 'complete' ? 2200 : 850);
  if (event.type === 'playerHurt') {
    document.body.classList.add('player-hit');
    setTimeout(() => document.body.classList.remove('player-hit'), 130);
  }
}

function renderHud() {
  if (!snapshot) return;
  elements.health.textContent = `${snapshot.player.health} / ${snapshot.player.maxHealth}`;
  const alive = (snapshot.enemies || []).filter((enemy) => enemy.alive).length;
  const collected = (snapshot.tokens || []).filter((token) => token.collected).length;
  elements['enemy-health'].textContent = `${alive} MOBS · ${collected}/${snapshot.tokens?.length || 0} TOKENS`;
}

function restartLevel() {
  if (socket?.readyState !== WebSocket.OPEN || (!snapshot?.dead && !snapshot?.complete)) return;
  clearInput();
  elements['again-button'].disabled = true;
  send({ type: 'sliceRestart' });
}

function fail(message) {
  intentionalClose = true;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  clearInput();
  elements['error-text'].textContent = message;
  elements['play-button'].disabled = false;
  elements['play-button'].textContent = 'PLAY SOLO NOW';
  show('error');
}

function clearInput() {
  for (const key of Object.keys(input)) input[key] = false;
}

for (const eventName of ['keydown', 'keyup']) {
  window.addEventListener(eventName, (event) => {
    const action = actionForSliceCode(event.code);
    if (!action) return;
    if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) {
      if (eventName === 'keyup') input[action] = false;
      return;
    }
    event.preventDefault();
    input[action] = eventName === 'keydown';
  });
}
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
document.addEventListener('focusin', (event) => {
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) clearInput();
});
setInterval(() => {
  if (level && !snapshot?.complete && !snapshot?.dead) {
    send({ type: 'sliceInput', sequence: sequence++, input });
  }
}, 33);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = false;
}

function rect(x, y, width, height, color) {
  context.fillStyle = color;
  context.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

function draw(now) {
  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#090b12';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  const worldHeight = level?.height || 720;
  const scale = viewHeight / worldHeight;
  const visibleWorldWidth = viewWidth / scale;
  const renderedPlayerPosition = renderedPosition('player', now);
  const playerX = renderedPlayerPosition?.x || 82;
  const camera = level
    ? Math.max(0, Math.min(level.width - visibleWorldWidth, playerX - visibleWorldWidth * 0.28))
    : 0;

  context.save();
  context.scale(scale, scale);
  context.translate(-camera, 0);
  rect(camera, 0, visibleWorldWidth, worldHeight, '#0b0d17');
  rect(camera, 0, visibleWorldWidth, 360, '#111526');

  for (let x = 80; x < (level?.width || 1600); x += 210) {
    rect(x, 90 + ((x / 210) % 2) * 42, 38, 100, '#1d2538');
    rect(x + 7, 105 + ((x / 210) % 2) * 42, 24, 56, '#8b6d45');
  }
  for (const solid of level?.solids || []) {
    rect(solid.x, solid.y, solid.width, solid.height, solid.y >= level.floorY ? '#25232d' : '#5b3942');
    rect(solid.x, solid.y, solid.width, Math.min(7, solid.height), solid.y >= level.floorY ? '#7a6650' : '#8c5a61');
  }
  if (level?.exit) {
    rect(level.exit.x, level.exit.y, level.exit.width, level.exit.height, '#352a4c');
    rect(level.exit.x + 7, level.exit.y + 9, level.exit.width - 14, level.exit.height - 9, '#9d6cc2');
  }

  if (snapshot) {
    const player = snapshot.player;
    const px = renderedPlayerPosition.x;
    const py = renderedPlayerPosition.y;
    rect(px - 18, py - 24, 36, 48, player.health <= 2 ? '#ff6b74' : '#48d1c5');
    rect(px - 10, py - 17, 20, 12, '#e6e1cf');
    rect(px - (player.facing > 0 ? 17 : 2), py + 3, 19, 26, '#225c67');
    if (player.attacking) {
      const attackX = player.facing > 0 ? px + 18 : px - 82;
      rect(attackX, py - 16, 64, 9, '#fff0a8');
      rect(attackX + (player.facing > 0 ? 22 : 36), py - 23, 6, 23, '#d9a844');
    }

    for (const token of snapshot.tokens || []) {
      if (token.collected) continue;
      rect(token.x - 9, token.y - 12, 18, 24, '#f6c85f');
      rect(token.x - 4, token.y - 8, 8, 16, '#fff0a8');
    }

    for (const enemy of snapshot.enemies || []) {
      const ex = enemy.position.x;
      const ey = enemy.position.y;
      if (!enemy.alive) {
        rect(ex - 24, ey + 20, 48, 8, '#6c3742');
        continue;
      }
      const enemyColor = enemy.type === 'crawler' ? '#7b496e' : enemy.type === 'guard' ? '#7a4663' : '#9d3448';
      rect(ex - 22, ey - 28, 44, 56, enemy.hit ? '#fff3c4' : enemyColor);
      rect(ex - 14, ey - 20, 28, 14, '#291a26');
      rect(ex - 11, ey - 16, 6, 5, '#ffce66');
      rect(ex + 5, ey - 16, 6, 5, '#ffce66');
      const barWidth = 54;
      rect(ex - barWidth / 2, ey - 44, barWidth, 6, '#21151a');
      rect(ex - barWidth / 2, ey - 44, barWidth * enemy.health / enemy.maxHealth, 6, '#d84c58');
    }
  }
  context.restore();

  if (!level) {
    context.fillStyle = '#cabdca';
    context.font = '14px ui-monospace, monospace';
    context.fillText('SOLO COMBAT PREVIEW · PLACEHOLDER ART', 18, viewHeight - 20);
  }
  requestAnimationFrame(draw);
}

const savedName = localStorage.getItem('coinrush-slice-name');
if (savedName) elements['player-name'].value = savedName.slice(0, 18);
elements['play-button'].addEventListener('click', connect);
elements['player-name'].addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });
elements['again-button'].addEventListener('click', restartLevel);
elements['retry-button'].addEventListener('click', () => window.location.reload());
window.addEventListener('resize', resize);
resize();
show('setup');
requestAnimationFrame(draw);
