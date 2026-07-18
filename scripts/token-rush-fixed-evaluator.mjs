#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SoloSliceRoom } from '../server/solo-slice-room.js';
import { compileTokenRushLevel } from '../shared/token-rush-level.js';
import { TOKEN_RUSH_DESIGNER, TOKEN_RUSH_DESIGNER_SEED } from './token-rush-level-designer.mjs';

export const TOKEN_RUSH_EVALUATOR = 'token-rush-authority-evaluator/v1';
export const TOKEN_RUSH_CONTROLLER = 'hold-right-grounded-five-jump/v1';
export const TOKEN_RUSH_SEED = 0x20260718;
export const TOKEN_RUSH_MAX_TICKS = 4000;
export const TOKEN_RUSH_SCORE_FORMULA = 'completed*10000-deaths*5000-damage*500+tokens*100-ticks';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultHistoryFile = path.join(repositoryRoot, 'content/token-rush-learning/history.jsonl');
const activeLevelFile = path.join(repositoryRoot, 'content/token-rush-level.json');
const REQUIRED_RESULT_KEYS = Object.freeze(['levelSha', 'completed', 'deaths', 'damage', 'tokens', 'ticks', 'score']);

class EvaluatorSocket {
  constructor() {
    this.readyState = 1;
    this.messages = [];
    this.closed = null;
  }

  send(payload) {
    this.messages.push(JSON.parse(payload));
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function seededGroundedDelays(seed) {
  let state = seed >>> 0;
  return Array.from({ length: 5 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 3;
  });
}

export const TOKEN_RUSH_GROUNDED_DELAYS = Object.freeze(seededGroundedDelays(TOKEN_RUSH_SEED));

export function scoreTokenRushTrial({ completed, deaths, damage, tokens, ticks }) {
  return Number(completed) * 10000 - deaths * 5000 - damage * 500 + tokens * 100 - ticks;
}

export function evaluateTokenRushLevelFile(levelFile) {
  const absoluteLevelFile = path.resolve(levelFile);
  const levelBytes = readFileSync(absoluteLevelFile);
  const document = JSON.parse(levelBytes.toString('utf8'));
  const level = compileTokenRushLevel(document);
  let now = 0;
  const room = new SoloSliceRoom({ now: () => now, level });
  const socket = new EvaluatorSocket();
  if (!room.connect(socket) || !room.receive(socket, { type: 'hello', name: 'Fixed Evaluator' })) {
    throw new Error('fixed evaluator could not join authoritative room');
  }

  let sequence = 0;
  let input = { left: false, right: false, jump: false, attack: false };
  const sendInput = (patch) => {
    input = { ...input, ...patch };
    const accepted = room.receive(socket, { type: 'sliceInput', sequence: sequence++, input });
    if (!accepted) throw new Error(`fixed controller input ${sequence - 1} was rejected`);
  };

  let previousHealth = room.player.health;
  const damageEvents = [];
  const advance = () => {
    room.tick(0.02);
    now += 20;
    if (room.player.health < previousHealth) {
      const event = [...room.feedback].reverse().find((candidate) => candidate.type === 'playerHurt' || candidate.type === 'playerDeath');
      damageEvents.push({
        tick: room.tickNumber,
        x: Number(room.player.position.x.toFixed(3)),
        amount: previousHealth - room.player.health,
        health: room.player.health,
        source: event?.text ?? 'unknown',
      });
    }
    previousHealth = room.player.health;
  };

  sendInput({ right: true });
  let groundedWait = 0;
  for (let step = 0; step < TOKEN_RUSH_MAX_TICKS && !room.complete && !room.dead; step += 1) {
    if (room.player.grounded && room.player.jumpCount < 5) {
      const jumpIndex = room.player.jumpCount;
      if (groundedWait >= TOKEN_RUSH_GROUNDED_DELAYS[jumpIndex]) {
        sendInput({ jump: true });
        advance();
        sendInput({ jump: false });
        groundedWait = 0;
      } else {
        groundedWait += 1;
      }
    } else {
      groundedWait = 0;
    }
    if (!room.complete && !room.dead) advance();
  }

  const completed = room.complete && !room.dead && room.player.jumpCount === 5;
  const deaths = Number(room.dead);
  const damage = room.player.maxHealth - room.player.health;
  const tokens = room.tokens.filter((token) => token.collected).length;
  const ticks = room.tickNumber;
  const score = scoreTokenRushTrial({ completed, deaths, damage, tokens, ticks });
  return Object.freeze({
    evaluator: TOKEN_RUSH_EVALUATOR,
    controller: TOKEN_RUSH_CONTROLLER,
    seed: TOKEN_RUSH_SEED,
    groundedDelays: [...TOKEN_RUSH_GROUNDED_DELAYS],
    formula: TOKEN_RUSH_SCORE_FORMULA,
    level: path.relative(repositoryRoot, absoluteLevelFile),
    levelSha: sha256(levelBytes),
    completed,
    deaths,
    damage,
    tokens,
    ticks,
    score,
    jumps: room.player.jumpCount,
    finalHealth: room.player.health,
    damageEvents,
  });
}

function parseHistory(historyFile) {
  const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('feedback history must contain the baseline run');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`history line ${index + 1} is not JSON`);
    }
  });
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function verifyTokenRushHistory(historyFile = defaultHistoryFile) {
  const absoluteHistoryFile = path.resolve(historyFile);
  const history = parseHistory(absoluteHistoryFile);
  const replay = [];
  let previousRun = 0;

  for (const entry of history) {
    if (!Number.isSafeInteger(entry.run) || entry.run !== previousRun + 1) throw new Error('history run numbers must be append-only and consecutive');
    previousRun = entry.run;
    if (!['baseline', 'revised', 'counterfactual'].includes(entry.role)) throw new Error(`run ${entry.run} has invalid role`);
    if (typeof entry.level !== 'string' || path.isAbsolute(entry.level) || entry.level.includes('..')) throw new Error(`run ${entry.run} has unsafe level path`);
    if (!Array.isArray(entry.memoryRuns) || entry.memoryRuns.some((run) => !Number.isSafeInteger(run) || run >= entry.run)) {
      throw new Error(`run ${entry.run} has invalid memory lineage`);
    }
    if (typeof entry.lesson !== 'string' || entry.lesson.length < 8 || entry.lesson.length > 240) throw new Error(`run ${entry.run} has invalid durable lesson`);
    const result = evaluateTokenRushLevelFile(path.join(repositoryRoot, entry.level));
    for (const key of REQUIRED_RESULT_KEYS) {
      if (!equalJson(entry[key], result[key])) throw new Error(`run ${entry.run} replay mismatch for ${key}`);
    }
    if (entry.evaluator !== TOKEN_RUSH_EVALUATOR || entry.controller !== TOKEN_RUSH_CONTROLLER || entry.seed !== TOKEN_RUSH_SEED || entry.formula !== TOKEN_RUSH_SCORE_FORMULA) {
      throw new Error(`run ${entry.run} changed the frozen benchmark`);
    }
    if (entry.designer !== TOKEN_RUSH_DESIGNER || entry.designerSeed !== TOKEN_RUSH_DESIGNER_SEED ||
        !['seed', 'learned', 'withheld'].includes(entry.generationMemory)) {
      throw new Error(`run ${entry.run} changed the frozen generator conditions`);
    }
    replay.push({ ...entry, result });
  }

  const mainline = replay.filter((entry) => entry.role !== 'counterfactual');
  if (mainline[0]?.role !== 'baseline' || mainline[0].memoryRuns.length !== 0 || mainline[0].generationMemory !== 'seed') {
    throw new Error('run 1 must be a memory-free baseline');
  }
  for (let index = 1; index < mainline.length; index += 1) {
    const expectedMemory = mainline.slice(0, index).map((entry) => entry.run);
    if (mainline[index].role !== 'revised' || mainline[index].generationMemory !== 'learned' ||
        !equalJson(mainline[index].memoryRuns, expectedMemory)) {
      throw new Error(`run ${mainline[index].run} did not consume the complete prior-run memory`);
    }
    if (mainline[index].score <= mainline[index - 1].score) throw new Error('mainline score did not improve strictly');
  }

  const counterfactuals = replay.filter((entry) => entry.role === 'counterfactual');
  for (const entry of counterfactuals) {
    if (entry.memoryRuns.length !== 0 || entry.generationMemory !== 'withheld') throw new Error('counterfactual must withhold learned memory');
    if (entry.score > mainline[0].score) throw new Error('memory-withheld counterfactual beat baseline');
  }
  if (mainline.length >= 3 && counterfactuals.length !== 1) throw new Error('final lineage requires exactly one memory-withheld counterfactual');

  const activeBytes = readFileSync(activeLevelFile);
  const finalMainlineBytes = readFileSync(path.join(repositoryRoot, mainline.at(-1).level));
  if (!activeBytes.equals(finalMainlineBytes)) throw new Error('active level must be byte-identical to the latest mainline trial');

  return Object.freeze({
    status: 'PASS',
    evaluator: TOKEN_RUSH_EVALUATOR,
    controller: TOKEN_RUSH_CONTROLLER,
    seed: TOKEN_RUSH_SEED,
    groundedDelays: [...TOKEN_RUSH_GROUNDED_DELAYS],
    formula: TOKEN_RUSH_SCORE_FORMULA,
    history: path.relative(repositoryRoot, absoluteHistoryFile),
    runs: replay.map((entry) => ({
      run: entry.run,
      role: entry.role,
      levelSha: entry.levelSha,
      completed: entry.completed,
      deaths: entry.deaths,
      damage: entry.damage,
      tokens: entry.tokens,
      ticks: entry.ticks,
      score: entry.score,
      generationMemory: entry.generationMemory,
      memoryRuns: entry.memoryRuns,
      lesson: entry.lesson,
    })),
    baselineScore: mainline[0].score,
    latestScore: mainline.at(-1).score,
    improvement: mainline.at(-1).score - mainline[0].score,
    counterfactualScore: counterfactuals[0]?.score ?? null,
  });
}

function main() {
  const result = process.argv.length > 2
    ? process.argv.slice(2).map((file) => evaluateTokenRushLevelFile(file))
    : verifyTokenRushHistory();
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
