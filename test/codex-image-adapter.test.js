import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ADAPTER_ID,
  GENERATION_PROFILE,
  IMAGE_REQUEST_SCHEMA,
  POSES,
  PYTHON_EXECUTABLE,
  buildImagePrompt,
  normalizeImageRequest,
  prepareDryRun,
  runDryRun,
} from '../scripts/asset-generation/codex-image-adapter.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(repositoryRoot, 'test/fixtures/imagegen/crypt-sentinel-idle.request.json');
const imageGenScript = path.join(repositoryRoot, 'test/fixtures/imagegen/fake/image_gen.py');
const wrapperPath = path.join(repositoryRoot, 'scripts/asset-generation/generate-pose-source.mjs');

async function fixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

function changed(request, overrides) {
  return { ...request, ...overrides };
}

test('the accepted five-pose union produces deterministic original-art prompts', async () => {
  const request = await fixture();
  const prompts = POSES.map((pose) => buildImagePrompt(changed(request, { pose })));

  assert.deepEqual(POSES, ['idle', 'move', 'attack', 'hit', 'death']);
  assert.equal(new Set(prompts).size, 5);
  for (const [index, prompt] of prompts.entries()) {
    assert.match(prompt, new RegExp(`Pose: ${POSES[index]} —`));
    assert.match(prompt, /exactly one creature/);
    assert.match(prompt, /strict orthographic side view facing right/);
    assert.match(prompt, /upper-left key light/);
    assert.match(prompt, /perfectly flat solid #00ff00/);
    assert.match(prompt, /original design/);
    assert.match(prompt, /no text, logo, caption, signature, watermark/);
    assert.doesNotMatch(prompt, /Castlevania|Konami|Belmont|Alucard/i);
  }
  assert.equal(buildImagePrompt(request), buildImagePrompt(structuredClone(request)));
});

test('request validation fails closed on unsafe shape, paths, copy language, and pose drift', async () => {
  const request = await fixture();
  assert.equal(normalizeImageRequest(request).schemaVersion, IMAGE_REQUEST_SCHEMA);

  for (const candidate of [
    changed(request, { extra: true }),
    changed(request, { enemyId: '../warden' }),
    changed(request, { enemyId: 'Warden' }),
    changed(request, { pose: 'jump' }),
    changed(request, { creature: 'copy a Castlevania sprite' }),
    changed(request, { silhouette: 'fetch https://example.test/reference.png' }),
    changed(request, { materials: [] }),
    changed(request, { materials: ['iron', 'IRON'] }),
    changed(request, { schemaVersion: 'coin-rush-image-request/v2' }),
  ]) {
    assert.throws(() => normalizeImageRequest(candidate), /IMAGE_REQUEST_/);
  }
});

test('dry-run plan pins model, source size, budgets, hashes, and forbids repository staging', async () => {
  const request = await fixture();
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-plan-'));
  try {
    const plan = await prepareDryRun(request, {
      repositoryRoot,
      stagingRoot,
      imageGenScript,
    });
    assert.equal(plan.config.adapter, ADAPTER_ID);
    assert.equal(plan.config.model, 'gpt-image-2');
    assert.equal(plan.config.size, '1024x1024');
    assert.equal(plan.executable, PYTHON_EXECUTABLE);
    assert.equal(plan.config.pythonExecutable, PYTHON_EXECUTABLE);
    assert.equal(plan.config.mode, 'dry-run-only');
    assert.equal(plan.config.publication, 'forbidden');
    assert.equal(plan.config.dryRunAttempts, 1);
    assert.equal(plan.config.dryRunDeadlineMs, 10_000);
    assert.equal(plan.config.nonExecutingLivePolicy.maxAttempts, 2);
    assert.equal(plan.config.nonExecutingLivePolicy.totalDeadlineMs, 60_000);
    assert.equal(plan.config.nonExecutingLivePolicy.cancelGraceMs, 2_000);
    assert.equal(plan.config.nonExecutingLivePolicy.retryBackoffMs, 500);
    assert.equal(plan.requestSha256.length, 64);
    assert.equal(plan.promptSha256.length, 64);
    assert.equal(plan.configSha256.length, 64);
    assert.equal(plan.imageGenScriptSha256.length, 64);
    assert.ok(plan.argv.includes('--dry-run'));
    assert.ok(plan.argv.includes('--no-augment'));
    assert.equal(plan.argv[plan.argv.indexOf('--model') + 1], GENERATION_PROFILE.model);
    assert.equal(plan.argv[plan.argv.indexOf('--size') + 1], GENERATION_PROFILE.size);
    assert.equal(plan.argv.includes('--max-attempts'), false);

    await assert.rejects(() => prepareDryRun(request, {
      repositoryRoot,
      stagingRoot: path.join(repositoryRoot, 'output/imagegen'),
      imageGenScript,
    }), /IMAGE_STAGING_IN_REPOSITORY/);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('CLI-compatible dry-run writes a sealed private receipt without generating or publishing art', async () => {
  const request = await fixture();
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-dry-run-'));
  const secretSentinel = 'must-not-enter-receipt';
  try {
    const plan = await prepareDryRun(request, {
      repositoryRoot,
      stagingRoot,
      imageGenScript,
    });
    const result = await runDryRun(plan, {
      env: { ...process.env, OPENAI_API_KEY: secretSentinel },
    });
    assert.equal(result.receipt.status, 'DRY_RUN_PASS');
    assert.equal(result.receipt.sourceGenerated, false);
    assert.equal(result.receipt.publication, 'forbidden');
    assert.equal(result.receipt.failureCode, null);
    assert.equal(result.receipt.provenance.model, 'gpt-image-2');
    assert.equal(result.receipt.provenance.pythonExecutable, PYTHON_EXECUTABLE);
    assert.equal(result.receipt.provenance.dryRunResponseValidated, true);
    assert.equal(result.receipt.provenance.dryRunWritesValidated, true);
    assert.equal(result.receipt.limits.dryRunAttempts, 1);
    assert.equal(result.receipt.limits.dryRunDeadlineMs, 10_000);
    assert.equal(result.receipt.nonExecutingLivePolicy.maxAttempts, 2);
    assert.equal(result.receipt.terminal.code, 0);
    assert.ok(result.receipt.terminal.stdoutBytes > 0);
    assert.equal(result.receiptSha256.length, 64);

    const receiptText = await readFile(result.receiptPath, 'utf8');
    assert.doesNotMatch(receiptText, new RegExp(secretSentinel));
    assert.doesNotMatch(receiptText, /OPENAI_API_KEY/);
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(result.outputDirectory, 'request.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(result.outputDirectory, 'prompt.txt'))).mode & 0o777, 0o600);
    await assert.rejects(access(plan.outputPath));
    await assert.rejects(() => runDryRun(plan), /IMAGE_STAGING_EXISTS/);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('staged request directories cannot escape through a precreated symlink', async () => {
  const request = await fixture();
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-stage-'));
  const escapedRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-escape-'));
  try {
    const plan = await prepareDryRun(request, {
      repositoryRoot,
      stagingRoot,
      imageGenScript,
    });
    await symlink(escapedRoot, plan.outputDirectory, 'dir');
    await assert.rejects(() => runDryRun(plan), /IMAGE_STAGING_ESCAPE/);
    await assert.rejects(access(path.join(escapedRoot, 'request.json')));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(escapedRoot, { recursive: true, force: true });
  }
});

test('a resolved staging-root symlink into a repository fails before creating the request directory', async () => {
  const request = await fixture();
  const fakeRepository = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-fake-repo-'));
  const linkParent = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-stage-link-'));
  const stagingRoot = path.join(linkParent, 'staging');
  try {
    await symlink(fakeRepository, stagingRoot, 'dir');
    const plan = await prepareDryRun(request, {
      repositoryRoot: fakeRepository,
      stagingRoot,
      imageGenScript,
    });
    await assert.rejects(() => runDryRun(plan), /IMAGE_STAGING_IN_REPOSITORY/);
    await assert.rejects(access(path.join(fakeRepository, plan.requestSha256)));
    assert.deepEqual(await readdir(fakeRepository), []);
  } finally {
    await rm(linkParent, { recursive: true, force: true });
    await rm(fakeRepository, { recursive: true, force: true });
  }
});

test('production and programmatic interpreter overrides fail before staging writes', async () => {
  const request = await fixture();
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-interpreter-'));
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        wrapperPath,
        '--request', fixturePath,
        '--staging-dir', stagingRoot,
        '--dry-run',
        '--python', '/bin/true',
      ]),
      (error) => {
        assert.match(error.stderr, /IMAGE_ADAPTER_ARGUMENT: unknown or incomplete argument --python/);
        return true;
      },
    );
    assert.deepEqual(await readdir(stagingRoot), []);

    const plan = await prepareDryRun(request, {
      repositoryRoot,
      stagingRoot,
      imageGenScript,
    });
    await assert.rejects(
      () => runDryRun({ ...plan, executable: '/bin/true' }),
      /IMAGE_TOOL_INTERPRETER/,
    );
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test('zero-exit output that does not match the image CLI dry-run contract cannot pass', async () => {
  const request = await fixture();
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-response-'));
  const toolRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-tool-'));
  const invalidTool = path.join(toolRoot, 'image_gen.py');
  try {
    await writeFile(invalidTool, '#!/usr/bin/env python3\nprint("{}")\n', { mode: 0o700 });
    const plan = await prepareDryRun(request, {
      repositoryRoot,
      stagingRoot,
      imageGenScript: invalidTool,
    });
    await assert.rejects(() => runDryRun(plan), /IMAGE_DRY_RUN_RESPONSE/);
    const receipt = JSON.parse(await readFile(path.join(plan.outputDirectory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'DRY_RUN_FAILED');
    assert.equal(receipt.failureCode, 'IMAGE_DRY_RUN_RESPONSE');
    assert.equal(receipt.provenance.dryRunResponseValidated, false);
    await assert.rejects(access(plan.outputPath));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(toolRoot, { recursive: true, force: true });
  }
});

test('a zero-exit CLI response cannot pass if the tool creates a source file', async () => {
  const request = await fixture();
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-write-'));
  const toolRoot = await mkdtemp(path.join(os.tmpdir(), 'coinrush-image-writing-tool-'));
  const writingTool = path.join(toolRoot, 'image_gen.py');
  try {
    const fixtureTool = await readFile(imageGenScript, 'utf8');
    await writeFile(writingTool, `${fixtureTool}\nopen(args[args.index("--out") + 1], "wb").write(b"not-an-image")\n`, { mode: 0o700 });
    const plan = await prepareDryRun(request, {
      repositoryRoot,
      stagingRoot,
      imageGenScript: writingTool,
    });
    await assert.rejects(() => runDryRun(plan), /IMAGE_DRY_RUN_WRITE/);
    const receipt = JSON.parse(await readFile(path.join(plan.outputDirectory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'DRY_RUN_FAILED');
    assert.equal(receipt.failureCode, 'IMAGE_DRY_RUN_WRITE');
    assert.equal(receipt.provenance.dryRunResponseValidated, true);
    assert.equal(receipt.provenance.dryRunWritesValidated, false);
    assert.equal((await readFile(plan.outputPath, 'utf8')), 'not-an-image');
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(toolRoot, { recursive: true, force: true });
  }
});

test('prototype adapter refuses any plan that does not retain the CLI dry-run flag', async () => {
  await assert.rejects(
    () => runDryRun({ dryRun: false, argv: [] }),
    /IMAGE_DRY_RUN_REQUIRED/,
  );
});
