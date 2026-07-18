import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readTokenRushLevelEvolution,
  tokenRushLevelEvolutionPlugin,
  TOKEN_RUSH_LEVEL_EVOLUTION_MODULE,
} from '../scripts/token-rush-level-evolution-data.mjs';

const historyFile = 'content/token-rush-learning/history.jsonl';
const activeLevelFile = 'content/token-rush-level.json';

function withFiles(callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'token-rush-evolution-'));
  const history = path.join(directory, 'history.jsonl');
  const active = path.join(directory, 'active.json');
  writeFileSync(history, readFileSync(historyFile));
  writeFileSync(active, readFileSync(activeLevelFile));
  try {
    callback({ directory, history, active });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('validated shipped history binds run scores, damage, active revision, and matched control', () => {
  const data = readTokenRushLevelEvolution({ historyFile, activeLevelFile });
  assert.deepEqual(data, {
    schema: 'token-rush-level-evolution/v1',
    activeRevision: 'crypt-001@token-rush-level-v1',
    activeLevelSha: '23e22466d2449b130ec3c53180310290d61d831aed378c3645138e499772bebb',
    runs: [
      { run: 1, score: 8819, damage: 2 },
      { run: 2, score: 9319, damage: 1 },
      { run: 3, score: 9819, damage: 0 },
    ],
    control: { run: 4, sourceRun: 2, score: 9319, damage: 1 },
  });
});

test('missing or malformed history hides evolution data instead of blocking the build', () => {
  assert.equal(readTokenRushLevelEvolution({ historyFile: '/does/not/exist', activeLevelFile }), null);
  withFiles(({ history, active }) => {
    writeFileSync(history, '{bad json}\n');
    assert.equal(readTokenRushLevelEvolution({ historyFile: history, activeLevelFile: active }), null);
    const plugin = tokenRushLevelEvolutionPlugin({ historyFile: history, activeLevelFile: active });
    const resolved = plugin.resolveId(TOKEN_RUSH_LEVEL_EVOLUTION_MODULE);
    assert.equal(plugin.load(resolved), 'export default null;');
  });
});

test('active-level drift and mismatched control provenance hide the panel fail-closed', () => {
  withFiles(({ history, active }) => {
    const changed = JSON.parse(readFileSync(active, 'utf8'));
    changed.enemies[2].x = 39;
    writeFileSync(active, `${JSON.stringify(changed, null, 2)}\n`);
    assert.equal(readTokenRushLevelEvolution({ historyFile: history, activeLevelFile: active }), null);
  });
  withFiles(({ history, active }) => {
    const lines = readFileSync(history, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    lines[3].generation.inputSha = '0'.repeat(64);
    writeFileSync(history, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    assert.equal(readTokenRushLevelEvolution({ historyFile: history, activeLevelFile: active }), null);
  });
});

test('canonical verifier hides relabeled scores and evaluator identity drift', () => {
  const cases = [
    (lines) => { lines[0].score = 8000; },
    (lines) => { lines[1].score = 9000; lines[3].score = 9000; },
    (lines) => { lines[0].evaluator = 'other-evaluator/v1'; },
  ];
  for (const mutate of cases) {
    withFiles(({ history, active }) => {
      const lines = readFileSync(history, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      mutate(lines);
      writeFileSync(history, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
      assert.equal(readTokenRushLevelEvolution({ historyFile: history, activeLevelFile: active }), null);
    });
  }
});

test('Vite virtual module contains only the validated read-only summary', () => {
  const plugin = tokenRushLevelEvolutionPlugin({ historyFile, activeLevelFile });
  const resolved = plugin.resolveId(TOKEN_RUSH_LEVEL_EVOLUTION_MODULE);
  assert.equal(resolved, `\0${TOKEN_RUSH_LEVEL_EVOLUTION_MODULE}`);
  const source = plugin.load(resolved);
  assert.match(source, /^export default \{"schema":"token-rush-level-evolution\/v1"/);
  assert.doesNotMatch(source, /nextEdit|lesson|damageEvents/);
});
