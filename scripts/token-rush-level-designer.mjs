#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileTokenRushLevel } from '../shared/token-rush-level.js';

export const TOKEN_RUSH_DESIGNER = 'token-rush-bounded-designer/v1';
export const TOKEN_RUSH_DESIGNER_SEED = 0x20260718;
export const TOKEN_RUSH_MEMORY_MODES = Object.freeze(['learned', 'withheld']);

function parseHistory(historyFile) {
  return readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is out of bounds`);
  return value;
}

function applyEdit(document, edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('learned memory has no nextEdit');
  const keys = Object.keys(edit).sort();
  if (edit.kind === 'moveEnemy' && JSON.stringify(keys) === JSON.stringify(['index', 'kind', 'x', 'y'])) {
    const index = integer(edit.index, 0, document.enemies.length - 1, 'enemy index');
    document.enemies[index] = {
      ...document.enemies[index],
      x: integer(edit.x, 0, 47, 'enemy x'),
      y: integer(edit.y, 0, 19, 'enemy y'),
    };
    return;
  }
  if (edit.kind === 'moveToken' && JSON.stringify(keys) === JSON.stringify(['index', 'kind', 'x', 'y'])) {
    const index = integer(edit.index, 0, document.tokens.length - 1, 'token index');
    document.tokens[index] = {
      x: integer(edit.x, 0, 47, 'token x'),
      y: integer(edit.y, 0, 19, 'token y'),
    };
    return;
  }
  throw new Error('nextEdit is outside the bounded level-only edit allowlist');
}

export function generateTokenRushCandidate({ sourceFile, historyFile, outputFile, memoryMode }) {
  if (!TOKEN_RUSH_MEMORY_MODES.includes(memoryMode)) throw new Error('memoryMode must be learned or withheld');
  const document = JSON.parse(readFileSync(sourceFile, 'utf8'));
  const history = parseHistory(historyFile);
  if (memoryMode === 'learned') {
    if (history.length === 0) throw new Error('learned generation requires prior history');
    applyEdit(document, history.at(-1).nextEdit);
  }
  compileTokenRushLevel(document);
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(outputFile, bytes, { mode: 0o600 });
  return Object.freeze({
    designer: TOKEN_RUSH_DESIGNER,
    seed: TOKEN_RUSH_DESIGNER_SEED,
    memoryMode,
    source: path.resolve(sourceFile),
    historyRuns: memoryMode === 'learned' ? history.map((entry) => entry.run) : [],
    output: path.resolve(outputFile),
  });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`);
  return process.argv[index + 1];
}

function main() {
  const result = generateTokenRushCandidate({
    sourceFile: valueAfter('--source'),
    historyFile: valueAfter('--history'),
    outputFile: valueAfter('--output'),
    memoryMode: valueAfter('--memory'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}
