import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_TOKEN_RUSH_ENEMY_FILE,
  FALLBACK_TOKEN_RUSH_ENEMY_CATALOG,
  loadTokenRushEnemyCatalogFile,
  TOKEN_RUSH_ENEMY_MAX_BYTES,
  TokenRushEnemyError,
  validateTokenRushEnemyCatalog,
} from '../shared/token-rush-enemies.js';

const clone = (value) => structuredClone(value);

async function authoredCatalog() {
  return JSON.parse(await readFile(DEFAULT_TOKEN_RUSH_ENEMY_FILE, 'utf8'));
}

function rejection(document, code) {
  assert.throws(() => validateTokenRushEnemyCatalog(document), (error) =>
    error instanceof TokenRushEnemyError && error.code === code);
}

function flatten(part) {
  return [part, ...part.children.flatMap(flatten)];
}

test('authored catalog pins four fully data-defined enemies and a three-level multipart boss', async () => {
  const loaded = loadTokenRushEnemyCatalogFile();
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.rejectionCode, null);
  assert.equal(loaded.catalog.enemies.length, 4);
  assert.match(loaded.catalog.revision, /^crypt-enemies-002@[0-9a-f]{12}$/);
  assert.equal(loaded.catalog.sha256.length, 64);

  const boss = loaded.catalog.byId['ossuary-colossus'];
  const parts = flatten(boss.body);
  assert.equal(parts.length, 7);
  assert.equal(parts.some((part) => part.id === 'crown'), true);
  assert.equal(parts.some((part) => part.id === 'left-claw'), true);
  assert.equal(boss.body.children.length, 3);
  assert.equal(boss.controllers.some((controller) => controller.states.some((state) =>
    state.transitions.some((transition) => transition.actions.some((action) => action.op === 'part.detach')))), true);
  assert.equal(boss.attacks.length, 6);
  assert.equal(JSON.stringify(boss).includes('projectile'), false);
  assert.equal(JSON.stringify(boss).includes('script'), false);
  assert.equal(JSON.stringify(boss).includes('http'), false);
});

test('catalog rejects unknown code-like data, unsafe reads and ops, references, and recursive body excess', async () => {
  const original = await authoredCatalog();
  const cases = [
    ['ENEMY_CATALOG_KEYS', (value) => { value.script = 'no'; }],
    ['ENEMY_DEFINITION_KEYS', (value) => { value.enemies[0].url = 'https://example.test'; }],
    ['ENEMY_DEFINITION_NAME', (value) => { value.enemies[0].name = 'https://example.test'; }],
    ['ENEMY_DEFINITION_ASSET', (value) => { value.enemies[0].assetPack = '../escape'; }],
    ['ENEMY_ACTION_OP', (value) => { value.enemies[0].controllers[0].states[0].tick[0].op = 'eval'; }],
    ['ENEMY_EXPRESSION_READ', (value) => { value.enemies[0].controllers[0].states[0].tick[0].value = { read: 'process.env' }; }],
    ['ENEMY_TRANSITION_TARGET', (value) => { value.enemies[0].controllers[0].states[0].transitions[0].to = 'missing'; }],
    ['ENEMY_ATTACK_KEYS', (value) => { value.enemies[0].attacks[0].projectile = {}; }],
    ['ENEMY_PART_DEPTH', (value) => {
      let part = value.enemies[3].body.children[0].children[0];
      for (let depth = 0; depth < 3; depth += 1) {
        const child = clone(part);
        child.id = `too-deep-${depth}`;
        child.children = [];
        part.children = [child];
        part = child;
      }
    }],
  ];
  for (const [code, mutate] of cases) {
    const document = clone(original);
    mutate(document);
    rejection(document, code);
  }
});

test('invalid, oversized, and missing catalog files fail closed to immutable legacy definitions', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'token-rush-enemies-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const invalid = path.join(directory, 'invalid.json');
  await writeFile(invalid, '{"schema":');
  const malformed = loadTokenRushEnemyCatalogFile(invalid);
  assert.equal(malformed.source, 'fallback');
  assert.equal(malformed.rejectionCode, 'ENEMY_FILE_JSON');
  assert.equal(malformed.catalog, FALLBACK_TOKEN_RUSH_ENEMY_CATALOG);
  assert.deepEqual(malformed.catalog.enemies.map((enemy) => enemy.id), ['crawler', 'guard', 'warden']);

  const oversized = path.join(directory, 'oversized.json');
  await writeFile(oversized, ' '.repeat(TOKEN_RUSH_ENEMY_MAX_BYTES + 1));
  const tooLarge = loadTokenRushEnemyCatalogFile(oversized);
  assert.equal(tooLarge.source, 'fallback');
  assert.equal(tooLarge.rejectionCode, 'ENEMY_FILE_SIZE');

  const missing = loadTokenRushEnemyCatalogFile(path.join(directory, 'missing.json'));
  assert.equal(missing.source, 'fallback');
  assert.equal(missing.rejectionCode, 'ENEMY_FILE_READ');
});
