import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

import { MAX_ACTION_MESSAGE_BYTES } from '../shared/action-protocol.js';
import { GAME } from '../shared/game.js';
import { activeLevelCandidate } from '../shared/levels/index.js';
import { GameRoom } from './game-room.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDist = path.join(repositoryRoot, 'dist');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function serveStatic(request, response, distDirectory) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method not allowed.');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    sendText(response, 400, 'Bad request.');
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.resolve(distDirectory, relative);
  if (!file.startsWith(`${path.resolve(distDirectory)}${path.sep}`)) {
    sendText(response, 404, 'Not found.');
    return;
  }

  let details;
  try {
    details = await stat(file);
  } catch {
    file = path.join(distDirectory, 'index.html');
    try {
      details = await stat(file);
    } catch {
      sendText(response, 503, 'Coin Rush client has not been built yet.');
      return;
    }
  }
  if (!details.isFile()) {
    sendText(response, 404, 'Not found.');
    return;
  }

  const extension = path.extname(file);
  const headers = {
    'content-type': contentTypes.get(extension) ?? 'application/octet-stream',
    'content-length': details.size,
    'x-content-type-options': 'nosniff',
    'cache-control': path.basename(file) === 'index.html'
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
}

export function createCoinRushServer({
  host = '127.0.0.1',
  port = 3000,
  allowedOrigin = '',
  distDirectory = defaultDist,
  level = activeLevelCandidate,
  handshakeTimeoutMs = 5000,
} = {}) {
  const room = new GameRoom({ level, now: () => performance.now() });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        revision: room.level.revision,
        connections: room.connectionCount,
        running: room.running,
      });
      sendText(response, 200, body, 'application/json; charset=utf-8');
      return;
    }
    void serveStatic(request, response, distDirectory).catch(() => {
      if (!response.headersSent) sendText(response, 500, 'Internal server error.');
      else response.destroy();
    });
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_ACTION_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws' || (allowedOrigin && request.headers.origin !== allowedOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
  });

  webSockets.on('connection', (socket) => {
    socket.isAlive = true;
    const peer = room.connect(socket);
    if (!peer) return;
    const handshakeTimer = setTimeout(() => {
      if (!peer.joined) socket.close(1008, 'Hello timeout');
    }, handshakeTimeoutMs);
    handshakeTimer.unref?.();

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text messages required');
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        socket.close(1007, 'Invalid JSON');
        return;
      }
      room.receive(socket, message, { byteLength: data.byteLength });
      if (peer.joined) clearTimeout(handshakeTimer);
    });
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      room.disconnect(socket);
    });
    socket.on('error', () => {});
  });

  let previousTick = performance.now();
  const gameTimer = setInterval(() => {
    const now = performance.now();
    room.tick((now - previousTick) / 1000);
    previousTick = now;
  }, 1000 / GAME.tickRate);
  gameTimer.unref?.();

  const heartbeatTimer = setInterval(() => {
    for (const socket of webSockets.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15000);
  heartbeatTimer.unref?.();

  return {
    room,
    server,
    webSockets,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      clearInterval(gameTimer);
      clearInterval(heartbeatTimer);
      for (const socket of webSockets.clients) socket.close(1001, 'Server shutting down');
      await new Promise((resolve) => webSockets.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const instance = createCoinRushServer({
    host,
    port,
    allowedOrigin: process.env.ALLOWED_ORIGIN || '',
  });
  await instance.listen();
  console.log(`Coin Rush listening on http://${host}:${port}`);
  const stop = async () => {
    await instance.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
