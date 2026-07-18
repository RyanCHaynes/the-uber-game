import './slice-style.css';

const elements = Object.fromEntries([
  'game-canvas', 'setup', 'player-name', 'play-button', 'hud', 'health', 'jumps',
  'enemy-health', 'feedback', 'complete', 'complete-text', 'again-button', 'error',
  'error-text', 'retry-button', 'legend',
].map((id) => [id, document.getElementById(id)]));

const canvas = elements['game-canvas'];
const context = canvas.getContext('2d', { alpha: false });
const input = { left: false, right: false, jump: false, attack: false };
let socket = null;
let sequence = 0;
let intentionalClose = false;
let level = null;
let snapshot = null;
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
  elements['play-button'].textContent = 'OPENING THE CRYPT…';
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
    if (!message.level || message.level.revision !== 'solo-slice-v1') throw new Error('slice revision mismatch');
    level = message.level;
    show('game');
    return;
  }
  if (message.type === 'sliceSnapshot') {
    if (!level || message.revision !== level.revision) throw new Error('snapshot revision mismatch');
    snapshot = message;
    renderHud();
    consumeFeedback(message.feedback || []);
    if (message.complete) {
      elements['complete-text'].textContent = `The Crypt Warden fell after ${message.player.jumpCount} authoritative jumps.`;
      elements.complete.classList.remove('hidden');
    }
    return;
  }
  if (message.type === 'sliceNotice') {
    showFeedback({ type: 'notice', text: String(message.text || '').slice(0, 160) });
    return;
  }
  throw new Error(`unknown message type ${message.type}`);
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
  elements.jumps.textContent = `${snapshot.player.jumpCount} / ${level.intendedJumpCount} JUMPS`;
  elements['enemy-health'].textContent = snapshot.enemy.alive
    ? `${snapshot.enemy.health} / ${snapshot.enemy.maxHealth}`
    : 'DEFEATED';
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

const bindings = new Map([
  ['KeyA', 'left'], ['ArrowLeft', 'left'],
  ['KeyD', 'right'], ['ArrowRight', 'right'],
  ['KeyW', 'jump'], ['ArrowUp', 'jump'], ['Space', 'jump'],
  ['KeyJ', 'attack'],
]);

for (const eventName of ['keydown', 'keyup']) {
  window.addEventListener(eventName, (event) => {
    const action = bindings.get(event.code);
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
  if (level && !snapshot?.complete) send({ type: 'sliceInput', sequence: sequence++, input });
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

function draw() {
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
  const playerX = snapshot?.player?.position?.x || 82;
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
  for (let x = 0; x < (level?.width || 1600); x += 64) {
    rect(x, 590, 62, 50, x % 128 ? '#383544' : '#423a48');
  }
  rect(0, level?.floorY || 640, level?.width || 1600, 80, '#25232d');
  rect(0, level?.floorY || 640, level?.width || 1600, 7, '#7a6650');

  for (const obstacle of level?.obstacles || []) {
    rect(obstacle.x, level.floorY - obstacle.height, obstacle.width, obstacle.height, '#5b3942');
    rect(obstacle.x + 5, level.floorY - obstacle.height + 6, obstacle.width - 10, 7, '#8c5a61');
  }

  if (snapshot) {
    const player = snapshot.player;
    const px = player.position.x;
    const py = player.position.y;
    rect(px - 18, py - 24, 36, 48, player.health <= 2 ? '#ff6b74' : '#48d1c5');
    rect(px - 10, py - 17, 20, 12, '#e6e1cf');
    rect(px - (player.facing > 0 ? 17 : 2), py + 3, 19, 26, '#225c67');
    if (player.attacking) {
      const attackX = player.facing > 0 ? px + 18 : px - 82;
      rect(attackX, py - 16, 64, 9, '#fff0a8');
      rect(attackX + (player.facing > 0 ? 22 : 36), py - 23, 6, 23, '#d9a844');
    }

    const enemy = snapshot.enemy;
    if (enemy.alive) {
      const ex = enemy.position.x;
      const ey = enemy.position.y;
      rect(ex - 22, ey - 28, 44, 56, enemy.hit ? '#fff3c4' : '#9d3448');
      rect(ex - 14, ey - 20, 28, 14, '#291a26');
      rect(ex - 11, ey - 16, 6, 5, '#ffce66');
      rect(ex + 5, ey - 16, 6, 5, '#ffce66');
      const barWidth = 70;
      rect(ex - barWidth / 2, ey - 48, barWidth, 7, '#21151a');
      rect(ex - barWidth / 2, ey - 48, barWidth * enemy.health / enemy.maxHealth, 7, '#d84c58');
    } else {
      rect(enemy.position.x - 28, level.floorY - 10, 56, 10, '#6c3742');
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
elements['again-button'].addEventListener('click', () => window.location.reload());
elements['retry-button'].addEventListener('click', () => window.location.reload());
window.addEventListener('resize', resize);
resize();
show('setup');
requestAnimationFrame(draw);
