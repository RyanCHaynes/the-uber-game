import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { verifyTokenRushHistory } from './token-rush-fixed-evaluator.mjs';

export const TOKEN_RUSH_LEVEL_EVOLUTION_MODULE = 'virtual:token-rush-level-evolution';
const resolvedModule = `\0${TOKEN_RUSH_LEVEL_EVOLUTION_MODULE}`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function finiteMetric(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

export function readTokenRushLevelEvolution({ historyFile, activeLevelFile }) {
  try {
    const verified = verifyTokenRushHistory(historyFile);
    const activeBytes = readFileSync(activeLevelFile);
    const active = JSON.parse(activeBytes.toString('utf8'));
    if (active.schema !== 'token-rush-level/v1' || typeof active.id !== 'string') throw new Error('invalid active level');

    const mainline = verified.runs.filter((entry) => entry.role !== 'counterfactual');
    const controls = verified.runs.filter((entry) => entry.role === 'counterfactual');
    if (mainline.length !== 3 || controls.length !== 1) throw new Error('invalid verified evolution roles');
    const finalRun = mainline[2];
    const control = controls[0];
    const sourceRun = mainline.find((entry) => entry.levelSha === control.sourceSha);
    const activeSha = sha256(activeBytes);
    if (!sourceRun || finalRun.levelSha !== activeSha || control.sourceSha !== sourceRun.levelSha) {
      throw new Error('active or control source binding mismatch');
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
