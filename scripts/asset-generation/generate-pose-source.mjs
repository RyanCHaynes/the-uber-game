#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareDryRun, runDryRun } from './codex-image-adapter.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/asset-generation/generate-pose-source.mjs \\',
    '    --request <request.json> --staging-dir <absolute-path> --dry-run',
    '',
    'This prototype intentionally refuses live generation and publication.',
  ].join('\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    const names = new Map([
      ['--request', 'requestPath'],
      ['--staging-dir', 'stagingRoot'],
      ['--image-gen-script', 'imageGenScript'],
      ['--python', 'pythonCommand'],
    ]);
    const key = names.get(token);
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`IMAGE_ADAPTER_ARGUMENT: unknown or incomplete argument ${token}`);
    }
    if (key in result) throw new Error(`IMAGE_ADAPTER_ARGUMENT: duplicate argument ${token}`);
    result[key] = argv[index + 1];
    index += 1;
  }
  if (!result.dryRun) throw new Error('IMAGE_DRY_RUN_REQUIRED: this prototype accepts only --dry-run');
  if (!result.requestPath || !result.stagingRoot) throw new Error('IMAGE_ADAPTER_ARGUMENT: --request and --staging-dir are required');
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = new URL('../../', import.meta.url);
  const repositoryRoot = fileURLToPath(sourceUrl);
  const requestPath = path.resolve(args.requestPath);
  const requestBytes = await readFile(requestPath);
  if (requestBytes.length > 16_384) throw new Error('IMAGE_REQUEST_BYTES: request file exceeds 16384 bytes');
  const request = JSON.parse(requestBytes.toString('utf8'));
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  const imageGenScript = args.imageGenScript || path.join(
    codexHome,
    'skills/.system/imagegen/scripts/image_gen.py',
  );
  const plan = await prepareDryRun(request, {
    repositoryRoot,
    stagingRoot: args.stagingRoot,
    imageGenScript,
    pythonCommand: args.pythonCommand || 'python3',
  });
  const result = await runDryRun(plan);
  process.stdout.write(`${JSON.stringify({
    status: result.receipt.status,
    requestSha256: result.receipt.requestSha256,
    promptSha256: result.receipt.promptSha256,
    configSha256: result.receipt.configSha256,
    receiptSha256: result.receiptSha256,
    receiptPath: result.receiptPath,
    sourceGenerated: false,
    publication: 'forbidden',
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n${usage()}\n`);
  process.exitCode = 1;
});
