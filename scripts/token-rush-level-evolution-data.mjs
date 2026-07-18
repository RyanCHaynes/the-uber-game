import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TOKEN_RUSH_LEVEL_EVOLUTION_MODULE = 'virtual:token-rush-level-evolution';
const resolvedModule = `\0${TOKEN_RUSH_LEVEL_EVOLUTION_MODULE}`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function finiteMetric(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

function parseHistory(bytes) {
  const lines = bytes.toString('utf8').split('\n').filter(Boolean);
  if (lines.length !== 4) throw new Error('expected three learned runs and one control');
  return lines.map((line) => JSON.parse(line));
}

export function readTokenRushLevelEvolution({ historyFile, activeLevelFile }) {
  try {
    const historyBytes = readFileSync(historyFile);
    const activeBytes = readFileSync(activeLevelFile);
    const history = parseHistory(historyBytes);
    const active = JSON.parse(activeBytes.toString('utf8'));
    if (active.schema !== 'token-rush-level/v1' || typeof active.id !== 'string') throw new Error('invalid active level');

    const mainline = history.filter((entry) => entry.role !== 'counterfactual');
    const controls = history.filter((entry) => entry.role === 'counterfactual');
    if (mainline.length !== 3 || controls.length !== 1) throw new Error('invalid evolution roles');
    if (mainline.some((entry, index) => entry.run !== index + 1 || !entry.completed || entry.deaths !== 0)) {
      throw new Error('invalid mainline result');
    }
    for (let index = 1; index < mainline.length; index += 1) {
      if (mainline[index].score <= mainline[index - 1].score) throw new Error('score did not improve');
      if (mainline[index].damage > mainline[index - 1].damage) throw new Error('damage regressed');
    }

    const finalRun = mainline[2];
    const sourceRun = mainline[1];
    const control = controls[0];
    const activeSha = sha256(activeBytes);
    if (finalRun.levelSha !== activeSha || finalRun.generation?.outputSha !== activeSha) throw new Error('active level is not final run');
    if (control.run !== 4 || control.generationPair !== finalRun.generationPair || control.generationMemory !== 'withheld') {
      throw new Error('invalid matched control');
    }
    for (const key of ['sourceSha', 'inputSha', 'methodSha', 'limitsSha']) {
      if (control.generation?.[key] !== finalRun.generation?.[key]) throw new Error(`control mismatch for ${key}`);
    }
    if (control.generation?.memorySha === finalRun.generation?.memorySha) throw new Error('control did not withhold memory');
    if (control.generation?.sourceSha !== sourceRun.levelSha || control.levelSha !== sourceRun.levelSha ||
        control.generation?.outputSha !== sourceRun.levelSha || control.score !== sourceRun.score || control.damage !== sourceRun.damage) {
      throw new Error('control does not match its source');
    }

    return Object.freeze({
      schema: 'token-rush-level-evolution/v1',
      activeRevision: `${active.id}@token-rush-level-v1`,
      activeLevelSha: activeSha,
      runs: mainline.map((entry) => Object.freeze({
        run: finiteMetric(entry.run, 'run'),
        score: finiteMetric(entry.score, 'score'),
        damage: finiteMetric(entry.damage, 'damage'),
      })),
      control: Object.freeze({
        run: finiteMetric(control.run, 'control run'),
        sourceRun: finiteMetric(sourceRun.run, 'control source run'),
        score: finiteMetric(control.score, 'control score'),
        damage: finiteMetric(control.damage, 'control damage'),
      }),
    });
  } catch {
    return null;
  }
}

export function tokenRushLevelEvolutionPlugin({
  historyFile = path.resolve('content/token-rush-learning/history.jsonl'),
  activeLevelFile = path.resolve('content/token-rush-level.json'),
} = {}) {
  return {
    name: 'token-rush-level-evolution',
    resolveId(id) {
      return id === TOKEN_RUSH_LEVEL_EVOLUTION_MODULE ? resolvedModule : null;
    },
    load(id) {
      if (id !== resolvedModule) return null;
      const data = readTokenRushLevelEvolution({ historyFile, activeLevelFile });
      return `export default ${JSON.stringify(data)};`;
    },
  };
}
