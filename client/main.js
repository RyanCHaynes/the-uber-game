import * as THREE from 'three';
import './style.css';

import { GAME, PLAYER_COLORS, SERVER_MESSAGE, TILE } from '../shared/game.js';
import { prepareLevel } from '../shared/level.js';
import { updateInputFromKeyboard } from './input.js';

const elements = Object.fromEntries([
  'setup', 'lobby', 'hud', 'winner', 'error', 'player-name', 'join-button',
  'lobby-players', 'ready-button', 'leave-button', 'game-leave-button',
  'notice', 'scores', 'winner-text', 'error-text', 'retry-button', 'game-canvas',
].map((id) => [id, document.getElementById(id)]));

let socket = null;
let intentionalClose = false;
let errorVisible = false;
let myId = null;
let level = null;
let lobbyPlayers = [];
let latestSnapshot = null;
let localReady = false;
let gameActive = false;

const input = { up: false, down: false, left: false, right: false };
const renderer = new THREE.WebGLRenderer({ canvas: elements['game-canvas'], antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1220);
scene.fog = new THREE.Fog(0x0d1220, 900, 1900);
const camera = new THREE.OrthographicCamera(-640, 640, 360, -360, 0.1, 3000);
camera.position.set(640, 360, 1000);
camera.lookAt(640, 360, 0);
const worldGroup = new THREE.Group();
scene.add(worldGroup);
const ambient = new THREE.HemisphereLight(0x9cb4ff, 0x15101e, 2.2);
scene.add(ambient);
const moonLight = new THREE.DirectionalLight(0xfff1c4, 2.4);
moonLight.position.set(400, 900, 900);
moonLight.castShadow = true;
scene.add(moonLight);

const playerMeshes = new Map();
let coinMesh = null;
let worldWidth = GAME.windowWidth;
let worldHeight = GAME.windowHeight;
let visibleWorldWidth = GAME.windowWidth;

function showScreen(name) {
  for (const id of ['setup', 'lobby', 'error']) elements[id].classList.toggle('hidden', id !== name);
  const inGame = name === 'game';
  elements.hud.classList.toggle('hidden', !inGame);
  elements['game-canvas'].classList.toggle('active', inGame);
  if (!inGame) elements.winner.classList.add('hidden');
}

function websocketUrl() {
  const url = new URL('/ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  const name = elements['player-name'].value.trim().slice(0, 18) || 'Player';
  localStorage.setItem('coinrush-name', name);
  elements['join-button'].disabled = true;
  elements['join-button'].textContent = 'CONNECTING…';
  intentionalClose = false;
  errorVisible = false;
  socket = new WebSocket(websocketUrl());
  socket.addEventListener('open', () => send({ type: 'hello', name }));
  socket.addEventListener('message', ({ data }) => {
    try {
      handleMessage(JSON.parse(data));
    } catch (error) {
      fail(`The server sent invalid game data: ${error.message}`);
    }
  });
  socket.addEventListener('close', ({ code, reason }) => {
    resetConnectionButton();
    if (errorVisible) return;
    if (intentionalClose) {
      resetSession();
      showScreen('setup');
    } else {
      fail(reason || `The server closed the connection (${code}).`);
    }
  });
  socket.addEventListener('error', () => {
    if (socket?.readyState !== WebSocket.OPEN) fail('Could not reach the Coin Rush server.');
  });
}

function handleMessage(message) {
  if (!message || typeof message.type !== 'string') throw new Error('missing message type');
  switch (message.type) {
    case SERVER_MESSAGE.WELCOME:
      myId = message.id;
      return;
    case SERVER_MESSAGE.LEVEL:
      level = prepareLevel(message.level);
      buildWorld(level);
      return;
    case SERVER_MESSAGE.LOBBY:
      lobbyPlayers = Array.isArray(message.players) ? message.players : [];
      localReady = lobbyPlayers.find((player) => player.id === myId)?.ready === true;
      renderLobby();
      gameActive = false;
      showScreen('lobby');
      return;
    case SERVER_MESSAGE.GAME_START:
      if (!level || message.revision !== level.revision) throw new Error('level revision mismatch');
      gameActive = true;
      latestSnapshot = null;
      elements.winner.classList.add('hidden');
      showScreen('game');
      return;
    case SERVER_MESSAGE.SNAPSHOT:
      if (!level || message.revision !== level.revision) throw new Error('snapshot revision mismatch');
      latestSnapshot = message;
      renderSnapshot(message);
      return;
    case SERVER_MESSAGE.NOTICE:
      elements.notice.textContent = String(message.text ?? '').slice(0, 160);
      return;
    default:
      throw new Error(`unknown message type ${message.type}`);
  }
}

function renderLobby() {
  elements['lobby-players'].replaceChildren();
  for (let slot = 0; slot < GAME.maxPlayers; slot += 1) {
    const player = lobbyPlayers.find((candidate) => candidate.slot === slot);
    const card = document.createElement('div');
    card.className = `player-card${player ? '' : ' empty'}`;
    if (!player) {
      card.textContent = 'Waiting for player…';
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.backgroundColor = PLAYER_COLORS[slot];
      avatar.style.boxShadow = `0 0 24px ${PLAYER_COLORS[slot]}55`;
      const name = document.createElement('div');
      name.className = 'player-name';
      name.textContent = `${player.name}${player.id === myId ? ' (you)' : ''}`;
      const ready = document.createElement('div');
      ready.className = `ready-state${player.ready ? ' yes' : ''}`;
      ready.textContent = player.ready ? 'READY' : 'NOT READY';
      card.append(avatar, name, ready);
    }
    elements['lobby-players'].append(card);
  }
  elements['ready-button'].textContent = localReady ? 'CANCEL READY' : 'READY UP';
}

function clearWorld() {
  playerMeshes.clear();
  coinMesh = null;
  while (worldGroup.children.length) {
    const child = worldGroup.children.pop();
    child.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
  }
}

function buildWorld(nextLevel) {
  clearWorld();
  worldWidth = nextLevel.width * nextLevel.tileSize;
  worldHeight = nextLevel.height * nextLevel.tileSize;

  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth + 400, worldHeight + 300),
    new THREE.MeshBasicMaterial({ color: 0x11182d }),
  );
  sky.position.set(worldWidth / 2, worldHeight / 2, -100);
  worldGroup.add(sky);

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(72, 32, 20),
    new THREE.MeshBasicMaterial({ color: 0xd9ddc9 }),
  );
  moon.position.set(worldWidth * 0.52, worldHeight - 115, -30);
  worldGroup.add(moon);

  const materials = {
    [TILE.STONE]: new THREE.MeshStandardMaterial({ color: 0x424158, roughness: 0.9 }),
    [TILE.BRICK]: new THREE.MeshStandardMaterial({ color: 0x6f3d49, roughness: 0.85 }),
    [TILE.PLATFORM]: new THREE.MeshStandardMaterial({ color: 0x957354, roughness: 0.8 }),
    [TILE.WINDOW]: new THREE.MeshStandardMaterial({ color: 0x253659, emissive: 0x17233d, emissiveIntensity: 1.5 }),
  };
  const geometry = new THREE.BoxGeometry(nextLevel.tileSize - 1, nextLevel.tileSize - 1, 22);
  for (let index = 0; index < nextLevel.tiles.length; index += 1) {
    const tile = nextLevel.tiles[index];
    if (!materials[tile]) continue;
    const x = index % nextLevel.width;
    const y = Math.floor(index / nextLevel.width);
    const block = new THREE.Mesh(geometry, materials[tile]);
    block.position.set(
      (x + 0.5) * nextLevel.tileSize,
      worldHeight - (y + 0.5) * nextLevel.tileSize,
      0,
    );
    block.castShadow = tile !== TILE.WINDOW;
    block.receiveShadow = true;
    worldGroup.add(block);
  }

  const starGeometry = new THREE.BufferGeometry();
  const stars = [];
  for (let index = 0; index < 100; index += 1) {
    stars.push((index * 173) % worldWidth, worldHeight - 30 - ((index * 97) % Math.max(80, worldHeight - 160)), -60);
  }
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
  worldGroup.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xbac8ef, size: 2.2 })));

  coinMesh = new THREE.Mesh(
    new THREE.TorusGeometry(GAME.coinRadius, 5, 12, 28),
    new THREE.MeshStandardMaterial({ color: 0xffd152, emissive: 0x9e6814, emissiveIntensity: 1.3, metalness: 0.55, roughness: 0.28 }),
  );
  coinMesh.castShadow = true;
  worldGroup.add(coinMesh);
}

function makePlayer(id, slot) {
  const group = new THREE.Group();
  const own = id === myId;
  const color = PLAYER_COLORS[slot] ?? PLAYER_COLORS[0];
  const capeColor = new THREE.Color(color).multiplyScalar(0.5);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(GAME.playerHalfWidth * 2, GAME.playerHalfHeight * 2, 28),
    new THREE.MeshStandardMaterial({ color, emissive: own ? color : 0x000000, emissiveIntensity: own ? 0.22 : 0, roughness: 0.55 }),
  );
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const cape = new THREE.Mesh(
    new THREE.ConeGeometry(25, 55, 3),
    new THREE.MeshStandardMaterial({ color: capeColor, side: THREE.DoubleSide }),
  );
  cape.rotation.z = Math.PI;
  cape.position.set(-12, -8, -12);
  group.add(cape);
  group.userData.target = new THREE.Vector3();
  worldGroup.add(group);
  playerMeshes.set(id, group);
  return group;
}

function renderSnapshot(snapshot) {
  const liveIds = new Set();
  for (const player of snapshot.players ?? []) {
    liveIds.add(player.id);
    const mesh = playerMeshes.get(player.id) ?? makePlayer(player.id, player.slot);
    mesh.userData.target.set(player.position.x, worldHeight - player.position.y, 25);
    if (!mesh.userData.initialized) {
      mesh.position.copy(mesh.userData.target);
      mesh.userData.initialized = true;
    }
  }
  for (const [id, mesh] of playerMeshes) {
    if (liveIds.has(id)) continue;
    worldGroup.remove(mesh);
    playerMeshes.delete(id);
  }
  if (coinMesh && snapshot.coin) coinMesh.position.set(snapshot.coin.x, worldHeight - snapshot.coin.y, 28);

  elements.scores.replaceChildren();
  for (const player of snapshot.players ?? []) {
    const score = document.createElement('span');
    score.className = 'score';
    score.style.color = PLAYER_COLORS[player.slot] ?? PLAYER_COLORS[0];
    score.textContent = `${player.name}  ${player.score}`;
    elements.scores.append(score);
  }
  if (snapshot.winnerId !== null && snapshot.winnerId !== undefined) {
    const winner = snapshot.players.find((player) => player.id === snapshot.winnerId);
    elements['winner-text'].textContent = snapshot.winnerId === myId ? 'YOU WIN!' : `${winner?.name ?? 'PLAYER'} WINS!`;
    elements.winner.classList.remove('hidden');
  }
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  const viewHeight = GAME.windowHeight;
  visibleWorldWidth = viewHeight * (width / height);
  camera.left = -visibleWorldWidth / 2;
  camera.right = visibleWorldWidth / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
}

function animate() {
  for (const mesh of playerMeshes.values()) mesh.position.lerp(mesh.userData.target, 0.32);
  if (coinMesh) {
    coinMesh.rotation.y += 0.045;
    coinMesh.rotation.x = 0.18 * Math.sin(performance.now() / 500);
  }
  const local = playerMeshes.get(myId);
  const desiredX = local?.position.x ?? worldWidth / 2;
  const half = visibleWorldWidth / 2;
  const cameraX = worldWidth > visibleWorldWidth
    ? THREE.MathUtils.clamp(desiredX, half, worldWidth - half)
    : worldWidth / 2;
  camera.position.set(cameraX, worldHeight / 2, 1000);
  camera.lookAt(cameraX, worldHeight / 2, 0);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

function fail(message) {
  errorVisible = true;
  intentionalClose = true;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  gameActive = false;
  elements['error-text'].textContent = message;
  resetConnectionButton();
  showScreen('error');
}

function resetConnectionButton() {
  elements['join-button'].disabled = false;
  elements['join-button'].textContent = 'JOIN LOBBY';
}

function clearInput() {
  for (const key of Object.keys(input)) input[key] = false;
}

function resetSession() {
  socket = null;
  myId = null;
  lobbyPlayers = [];
  latestSnapshot = null;
  localReady = false;
  gameActive = false;
  errorVisible = false;
  clearInput();
}

function leave() {
  intentionalClose = true;
  socket?.close(1000, 'Player left');
  resetSession();
  showScreen('setup');
}

for (const eventName of ['keydown', 'keyup']) {
  window.addEventListener(eventName, (event) => {
    updateInputFromKeyboard(event, eventName, input);
  });
}
window.addEventListener('blur', clearInput);
document.addEventListener('focusin', (event) => {
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) clearInput();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInput();
});
setInterval(() => {
  if (gameActive) send({ type: 'input', input });
}, 33);

const savedName = localStorage.getItem('coinrush-name');
if (savedName) elements['player-name'].value = savedName.slice(0, 18);
elements['join-button'].addEventListener('click', connect);
elements['player-name'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});
elements['ready-button'].addEventListener('click', () => send({ type: 'ready', ready: !localReady }));
elements['leave-button'].addEventListener('click', leave);
elements['game-leave-button'].addEventListener('click', leave);
elements['retry-button'].addEventListener('click', () => {
  resetSession();
  showScreen('setup');
});
window.addEventListener('resize', resize);
resize();
showScreen('setup');
