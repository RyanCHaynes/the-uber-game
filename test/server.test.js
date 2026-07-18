import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

import { createCoinRushServer } from '../server/index.js';

class Messages {
  constructor(socket) {
    this.items = [];
    this.waiters = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.items.push(message);
      this.flush();
    });
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const found = this.items.find(waiter.predicate);
      if (!found) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(found);
    }
  }

  wait(predicate, timeout = 3000) {
    const found = this.items.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out; saw ${this.items.map((item) => item.type).join(', ')}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}

function open(url, origin = 'https://game.test') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    const messages = new Messages(socket);
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

test('public shape serves client health and a real two-browser WebSocket round start', async (context) => {
  const dist = await mkdtemp(path.join(tmpdir(), 'coinrush-dist-'));
  await writeFile(path.join(dist, 'index.html'), '<h1>Coin Rush Three.js</h1>');
  const instance = createCoinRushServer({
    host: '127.0.0.1',
    port: 0,
    allowedOrigin: 'https://game.test',
    distDirectory: dist,
  });
  context.after(async () => {
    await instance.close();
    await rm(dist, { recursive: true, force: true });
  });
  const address = await instance.listen();
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const health = await fetch(`${httpUrl}/healthz`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.revision, 'castle-v1');
  assert.match(await fetch(httpUrl).then((response) => response.text()), /Three\.js/);

  const first = await open(wsUrl);
  const second = await open(wsUrl);
  first.socket.send(JSON.stringify({ type: 'hello', name: 'Ada' }));
  second.socket.send(JSON.stringify({ type: 'hello', name: 'Grace' }));
  await first.messages.wait((message) => message.type === 'lobby' && message.players.length === 2);
  await second.messages.wait((message) => message.type === 'level' && message.level.revision === 'castle-v1');

  first.socket.send(JSON.stringify({ type: 'ready', ready: true }));
  second.socket.send(JSON.stringify({ type: 'ready', ready: true }));
  await Promise.all([
    first.messages.wait((message) => message.type === 'gameStart'),
    second.messages.wait((message) => message.type === 'gameStart'),
    first.messages.wait((message) => message.type === 'snapshot' && message.players.length === 2),
  ]);
  first.socket.send(JSON.stringify({
    type: 'input',
    input: { up: false, down: false, left: false, right: true },
  }));
  const snapshot = await first.messages.wait((message) =>
    message.type === 'snapshot' && message.players.some((player) => player.position.x > 112));
  assert.equal(snapshot.revision, 'castle-v1');
  first.socket.close();
  second.socket.close();
});

test('wrong origin and malformed JSON are rejected', async (context) => {
  const instance = createCoinRushServer({ host: '127.0.0.1', port: 0, allowedOrigin: 'https://game.test' });
  context.after(() => instance.close());
  const address = await instance.listen();
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const forbiddenStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: 'https://evil.test' });
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('error', (error) => {
      if (!/403/.test(error.message)) reject(error);
    });
  });
  assert.equal(forbiddenStatus, 403);

  const malformed = await open(url);
  const closed = new Promise((resolve) => malformed.socket.once('close', (code) => resolve(code)));
  malformed.socket.send('{not-json');
  assert.equal(await closed, 1007);
});
