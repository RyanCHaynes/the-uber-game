import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateTokenRushLevelFile,
  TOKEN_RUSH_CONTROLLER,
  TOKEN_RUSH_EVALUATOR,
  TOKEN_RUSH_GROUNDED_DELAYS,
  TOKEN_RUSH_SCORE_FORMULA,
  TOKEN_RUSH_SEED,
  verifyTokenRushHistory,
} from '../scripts/token-rush-fixed-evaluator.mjs';
import {
  assertGeneratedTokenRushOutput,
  assertMatchedCounterfactual,
  generateTokenRushCandidate,
  TOKEN_RUSH_DESIGNER,
  TOKEN_RUSH_DESIGNER_SEED,
} from '../scripts/token-rush-level-designer.mjs';

const baselineFile = 'content/token-rush-learning/run-1-baseline.json';
const historyFile = 'content/token-rush-learning/history.jsonl';

test('fixed seed, controller, evaluator, formula, and ada0885 baseline replay exactly', () => {
  assert.equal(TOKEN_RUSH_DESIGNER, 'token-rush-bounded-designer/v1');
  assert.equal(TOKEN_RUSH_DESIGNER_SEED, 539363096);
  assert.equal(TOKEN_RUSH_EVALUATOR, 'token-rush-authority-evaluator/v1');
  assert.equal(TOKEN_RUSH_CONTROLLER, 'hold-right-grounded-five-jump/v1');
  assert.equal(TOKEN_RUSH_SEED, 539363096);
  assert.deepEqual(TOKEN_RUSH_GROUNDED_DELAYS, [1, 1, 1, 1, 2]);
  assert.equal(TOKEN_RUSH_SCORE_FORMULA, 'completed*10000-deaths*5000-damage*500+tokens*100-ticks');
  const method = JSON.parse(readFileSync('content/token-rush-learning/method.json', 'utf8'));
  assert.deepEqual({
    designer: method.designer,
    designerSeed: method.designerSeed,
    evaluator: method.evaluator,
    controller: method.controller,
    evaluatorSeed: method.evaluatorSeed,
    scoreFormula: method.scoreFormula,
    allowedEdits: method.generationLimits.allowedEdits,
  }, {
    designer: TOKEN_RUSH_DESIGNER,
    designerSeed: TOKEN_RUSH_DESIGNER_SEED,
    evaluator: TOKEN_RUSH_EVALUATOR,
    controller: TOKEN_RUSH_CONTROLLER,
    evaluatorSeed: TOKEN_RUSH_SEED,
    scoreFormula: TOKEN_RUSH_SCORE_FORMULA,
    allowedEdits: ['moveEnemy', 'moveToken'],
  });

  const result = evaluateTokenRushLevelFile(baselineFile);
  assert.deepEqual({
    levelSha: result.levelSha,
    completed: result.completed,
    deaths: result.deaths,
    damage: result.damage,
    tokens: result.tokens,
    ticks: result.ticks,
    score: result.score,
    jumps: result.jumps,
  }, {
    levelSha: '46bb9550370f1e08ad66f3d100927db67945e1ab45ae73c872f58d18bfaa2513',
    completed: true,
    deaths: 0,
    damage: 2,
    tokens: 1,
    ticks: 281,
    score: 8819,
    jumps: 5,
  });
  assert.deepEqual(result.damageEvents, [
    { tick: 126, x: 697.4, amount: 1, health: 4, source: 'Crypt Guard hits you' },
    { tick: 236, x: 1236.4, amount: 1, health: 3, source: 'Crypt Warden hits you' },
  ]);
});

test('append-only history replays every recorded result and exposes the score lineage', () => {
  const result = verifyTokenRushHistory(historyFile);
  assert.equal(result.status, 'PASS');
  assert.equal(result.runs[0].role, 'baseline');
  assert.equal(result.baselineScore, 8819);
  assert.ok(result.runs.length === 1 || result.improvement > 0);
});

test('same frozen Designer improves with run-1 memory while withheld memory does not', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'token-rush-designer-'));
  try {
    const firstHistoryLine = `${readFileSync(historyFile, 'utf8').split('\n').find(Boolean)}\n`;
    const firstHistory = path.join(directory, 'run-1-history.jsonl');
    const learnedFile = path.join(directory, 'learned.json');
    const withheldFile = path.join(directory, 'withheld.json');
    const mismatchedFile = path.join(directory, 'mismatched.json');
    const mismatchedSource = path.join(directory, 'mismatched-source.json');
    writeFileSync(firstHistory, firstHistoryLine);

    const learned = generateTokenRushCandidate({
      sourceFile: baselineFile,
      historyFile: firstHistory,
      outputFile: learnedFile,
      memoryMode: 'learned',
    });
    const withheld = generateTokenRushCandidate({
      sourceFile: baselineFile,
      historyFile: firstHistory,
      outputFile: withheldFile,
      memoryMode: 'withheld',
    });
    assert.equal(assertMatchedCounterfactual(learned, withheld), true);
    assert.deepEqual(learned.historyRuns, [1]);
    assert.deepEqual(withheld.historyRuns, []);
    assert.equal(learned.generation.sourceSha, withheld.generation.sourceSha);
    assert.equal(learned.generation.inputSha, withheld.generation.inputSha);
    assert.equal(learned.generation.methodSha, withheld.generation.methodSha);
    assert.equal(learned.generation.limitsSha, withheld.generation.limitsSha);
    assert.notEqual(learned.generation.memorySha, withheld.generation.memorySha);

    writeFileSync(mismatchedSource, `${readFileSync(baselineFile, 'utf8')}\n`);
    const mismatched = generateTokenRushCandidate({
      sourceFile: mismatchedSource,
      historyFile: firstHistory,
      outputFile: mismatchedFile,
      memoryMode: 'withheld',
    });
    assert.throws(() => assertMatchedCounterfactual(learned, mismatched), /mismatch for sourceSha/);

    const sourceBytes = readFileSync(baselineFile);
    const memoryBytes = readFileSync(firstHistory);
    assertGeneratedTokenRushOutput({
      sourceBytes,
      memoryBytes,
      memoryMode: 'learned',
      recordedBytes: readFileSync(learnedFile),
    });
    assertGeneratedTokenRushOutput({
      sourceBytes,
      memoryBytes: Buffer.alloc(0),
      memoryMode: 'withheld',
      recordedBytes: readFileSync(withheldFile),
    });
    assert.throws(() => assertGeneratedTokenRushOutput({
      sourceBytes,
      memoryBytes: Buffer.alloc(0),
      memoryMode: 'withheld',
      recordedBytes: sourceBytes,
    }), /not produced by deterministic Designer replay/);

    const baseline = evaluateTokenRushLevelFile(baselineFile);
    const learnedResult = evaluateTokenRushLevelFile(learnedFile);
    const withheldResult = evaluateTokenRushLevelFile(withheldFile);
    assert.ok(learnedResult.score > baseline.score);
    assert.equal(withheldResult.score, baseline.score);

    const baselineDocument = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const learnedDocument = JSON.parse(readFileSync(learnedFile, 'utf8'));
    const withheldDocument = JSON.parse(readFileSync(withheldFile, 'utf8'));
    assert.deepEqual(withheldDocument, baselineDocument);
    assert.deepEqual({ ...learnedDocument, enemies: baselineDocument.enemies }, baselineDocument);
    assert.deepEqual(learnedDocument.enemies.map((enemy, index) => index === 1 ? baselineDocument.enemies[index] : enemy), baselineDocument.enemies);
    assert.deepEqual(learnedDocument.enemies[1], { type: 'guard', x: 18, y: 13 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('history result drift fails closed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'token-rush-history-'));
  try {
    const drifted = JSON.parse(readFileSync(historyFile, 'utf8').split('\n').find(Boolean));
    drifted.score += 1;
    const file = path.join(directory, 'history.jsonl');
    writeFileSync(file, `${JSON.stringify(drifted)}\n`);
    assert.throws(() => verifyTokenRushHistory(file), /replay mismatch for score/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
