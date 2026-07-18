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

test('public shape serves health and a real ten-client WebSocket round with rejoin limits', async (context) => {
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

  const clients = [];
  for (let index = 0; index < 10; index += 1) {
    const client = await open(wsUrl);
    clients.push(client);
    client.socket.send(JSON.stringify({ type: 'hello', name: `Browser ${index + 1}` }));
  }
  const firstWelcome = await clients[0].messages.wait((message) => message.type === 'welcome');
  await clients[0].messages.wait((message) => message.type === 'lobby' && message.players.length === 10);
  await Promise.all(clients.map((client) =>
    client.messages.wait((message) => message.type === 'level' && message.level.revision === 'castle-v1')));

  clients.forEach((client) => client.socket.send(JSON.stringify({ type: 'ready', ready: true })));
  await Promise.all([
    ...clients.map((client) => client.messages.wait((message) => message.type === 'gameStart')),
    clients[0].messages.wait((message) => message.type === 'snapshot' && message.players.length === 10),
  ]);
  clients[0].socket.send(JSON.stringify({
    type: 'input',
    input: { up: false, down: false, left: false, right: true },
  }));
  const snapshot = await clients[0].messages.wait((message) =>
    message.type === 'snapshot' &&
    message.players.some((player) => player.id === firstWelcome.id && player.position.x > 112));
  assert.equal(snapshot.revision, 'castle-v1');

  clients[4].socket.close();
  await clients[0].messages.wait((message) =>
    message.type === 'lobby' && message.players.length === 9 &&
    message.players.every((player) => player.name !== 'Browser 5'));
  const replacement = await open(wsUrl);
  clients.push(replacement);
  replacement.socket.send(JSON.stringify({ type: 'hello', name: 'Replacement' }));
  await clients[0].messages.wait((message) =>
    message.type === 'lobby' && message.players.length === 10 &&
    message.players.some((player) => player.name === 'Replacement'));

  const eleventh = await open(wsUrl);
  const refused = new Promise((resolve) => eleventh.socket.once('close', (code) => resolve(code)));
  assert.equal(await refused, 1008);
  clients.forEach((client) => client.socket.close());
});

test('real action-v1 WebSockets negotiate, move, jump, and reject stale input', async (context) => {
  const instance = createCoinRushServer({ host: '127.0.0.1', port: 0, allowedOrigin: 'https://game.test' });
  context.after(() => instance.close());
  const address = await instance.listen();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const first = await open(url);
  const second = await open(url);
  const clients = [first, second];
  context.after(() => clients.forEach((client) => client.socket.close()));

  first.socket.send(JSON.stringify({ type: 'hello', name: 'Ada', protocol: 'action-v1' }));
  second.socket.send(JSON.stringify({ type: 'hello', name: 'Grace', protocol: 'action-v1' }));
  const welcome = await first.messages.wait((message) => message.type === 'welcome');
  assert.equal(welcome.protocol, 'action-v1');
  await first.messages.wait((message) => message.type === 'lobby' && message.players.length === 2);
  first.socket.send(JSON.stringify({ type: 'ready', ready: true }));
  second.socket.send(JSON.stringify({ type: 'ready', ready: true }));
  await first.messages.wait((message) => message.type === 'gameStart');

  const intent = {
    type: 'action',
    sequence: 1,
    held: { left: false, right: true, up: false, down: false },
    pressed: { jump: true, primary: false, secondary: false, interact: false, dodge: false, pause: false },
  };
  first.socket.send(JSON.stringify(intent));
  const moved = await first.messages.wait((message) =>
    message.type === 'snapshot' && message.players.some((player) =>
      player.id === welcome.id && player.position.x > 112 && player.position.y < 616));
  assert.equal(moved.revision, 'castle-v1');

  const staleClose = new Promise((resolve) => first.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  first.socket.send(JSON.stringify(intent));
  assert.deepEqual(await staleClose, {
    code: 1008,
    reason: 'stale_action_sequence: Action sequence is stale or duplicated.',
  });
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

  const oversized = await open(url);
  const oversizedClose = new Promise((resolve) => oversized.socket.once('close', (code) => resolve(code)));
  oversized.socket.send(JSON.stringify({ type: 'hello', name: 'x'.repeat(3000) }));
  assert.equal(await oversizedClose, 1009);
});
