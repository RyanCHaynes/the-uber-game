import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(file) {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

function ids(document) {
  return [...document.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

test('start screen exposes exactly the accepted singleplayer and multiplayer entries', async () => {
  const document = await source('index.html');

  assert.match(document, /href="\/singleplayer\.html"/);
  assert.match(document, /href="\/multiplayer\.html"/);
  assert.match(document, />SINGLEPLAYER</);
  assert.match(document, />MULTIPLAYER</);
  assert.match(document, /2–10 player/);
  assert.doesNotMatch(document, /client\/(?:slice-)?main\.js/);
  assert.equal(new Set(ids(document)).size, ids(document).length);
});

test('singleplayer entry retains Token Rush, the learning panel, and a route back', async () => {
  const document = await source('singleplayer.html');

  assert.match(document, /TOKEN RUSH/);
  assert.match(document, /src="\/client\/slice-main\.js"/);
  assert.match(document, /id="level-evolution"/);
  assert.match(document, /class="mode-back" href="\/"/);
  assert.equal(new Set(ids(document)).size, ids(document).length);
});

test('multiplayer entry restores every DOM surface used by the authoritative client', async () => {
  const document = await source('multiplayer.html');
  const requiredIds = [
    'game-canvas', 'setup', 'lobby', 'hud', 'winner', 'error', 'player-name', 'join-button',
    'lobby-players', 'ready-button', 'leave-button', 'game-leave-button', 'notice', 'scores',
    'winner-text', 'error-text', 'retry-button',
  ];

  assert.match(document, /src="\/client\/main\.js"/);
  assert.match(document, /2–10 players/);
  assert.match(document, /class="mode-back" href="\/"/);
  for (const id of requiredIds) assert.match(document, new RegExp(`id="${id}"`));
  assert.equal(new Set(ids(document)).size, ids(document).length);
});

test('Vite builds every HTML mode entry', async () => {
  const config = await source('vite.config.js');

  assert.match(config, /modes: path\.join\(repositoryRoot, 'index\.html'\)/);
  assert.match(config, /singleplayer: path\.join\(repositoryRoot, 'singleplayer\.html'\)/);
  assert.match(config, /multiplayer: path\.join\(repositoryRoot, 'multiplayer\.html'\)/);
});
