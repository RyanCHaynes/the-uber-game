import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_REQUEST_SCHEMA = 'coin-rush-image-request/v1';
export const RECEIPT_SCHEMA = 'coin-rush-image-request-receipt/v1';
export const ADAPTER_ID = 'coin-rush-codex-image-adapter/v1';
export const PYTHON_EXECUTABLE = '/usr/bin/python3';
export const POSES = Object.freeze(['idle', 'move', 'attack', 'hit', 'death']);
export const GENERATION_PROFILE = Object.freeze({
  model: 'gpt-image-2',
  size: '1024x1024',
  quality: 'medium',
  outputFormat: 'png',
  dryRunAttempts: 1,
  dryRunDeadlineMs: 10_000,
  futureLiveMaxAttempts: 2,
  futureLiveTotalDeadlineMs: 60_000,
  cancelGraceMs: 2_000,
  retryBackoffMs: 500,
  maxCapturedBytesPerStream: 65_536,
});

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'enemyId',
  'pose',
  'creature',
  'silhouette',
  'materials',
  'equipment',
]);
const PROHIBITED_COPY_TERMS = /\b(castlevania|konami|belmont|alucard|copy|replica|trace|sprite[ -]?sheet)\b/i;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]|(?:https?|file):\/\/|(?:^|\s)\.\.(?:\s|$)/i;

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('IMAGE_REQUEST_OBJECT', `${label} must be a plain object`);
  }
}

function requireText(value, label, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value !== value.trim()) {
    fail('IMAGE_REQUEST_TEXT', `${label} must be trimmed text between 1 and ${maximumLength} characters`);
  }
  if (UNSAFE_TEXT.test(value)) fail('IMAGE_REQUEST_UNSAFE_TEXT', `${label} contains a control, URL, or traversal token`);
  if (PROHIBITED_COPY_TERMS.test(value)) fail('IMAGE_REQUEST_COPY_TERM', `${label} asks for copied or full-sheet art`);
  return value;
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function normalizeImageRequest(value) {
  requirePlainObject(value, 'request');
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) fail('IMAGE_REQUEST_UNKNOWN_KEY', `unknown request key ${key}`);
  }
  for (const key of ['schemaVersion', 'enemyId', 'pose', 'creature', 'silhouette', 'materials']) {
    if (!(key in value)) fail('IMAGE_REQUEST_MISSING_KEY', `missing request key ${key}`);
  }
  if (value.schemaVersion !== IMAGE_REQUEST_SCHEMA) fail('IMAGE_REQUEST_SCHEMA', `expected ${IMAGE_REQUEST_SCHEMA}`);
  if (typeof value.enemyId !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.enemyId)) {
    fail('IMAGE_REQUEST_ENEMY_ID', 'enemyId must be a lower-case ASCII slug up to 48 characters');
  }
  if (!POSES.includes(value.pose)) fail('IMAGE_REQUEST_POSE', `pose must be one of ${POSES.join(', ')}`);
  if (!Array.isArray(value.materials) || value.materials.length < 1 || value.materials.length > 6) {
    fail('IMAGE_REQUEST_MATERIALS', 'materials must contain 1 to 6 entries');
  }
  const materials = value.materials.map((entry, index) => requireText(entry, `materials[${index}]`, 48));
  if (new Set(materials.map((entry) => entry.toLowerCase())).size !== materials.length) {
    fail('IMAGE_REQUEST_MATERIALS', 'materials must be unique');
  }
  const normalized = {
    schemaVersion: IMAGE_REQUEST_SCHEMA,
    enemyId: value.enemyId,
    pose: value.pose,
    creature: requireText(value.creature, 'creature', 120),
    silhouette: requireText(value.silhouette, 'silhouette', 180),
    materials,
  };
  if ('equipment' in value) normalized.equipment = requireText(value.equipment, 'equipment', 96);
  return Object.freeze(normalized);
}

const POSE_DIRECTION = Object.freeze({
  idle: 'alert neutral stance with the clearest identity silhouette and resting equipment',
  move: 'strong rightward contact or passing pose with coherent proportions and no extra limbs',
  attack: 'unambiguous right-facing primary-attack anticipation or contact silhouette',
  hit: 'readable recoil away from an incoming hit while preserving identity and equipment',
  death: 'collapsed or dissolving terminal silhouette with no detached particles or baked floor',
});

export function buildImagePrompt(requestValue) {
  const request = normalizeImageRequest(requestValue);
  const equipment = request.equipment || 'no separate equipment';
  return [
    'Use case: stylized-concept',
    'Asset type: Coin Rush enemy key-pose source candidate for deterministic pixel-art normalization',
    `Primary request: Create one original gothic-medieval 16-bit-era pixel-art ${request.creature}.`,
    'Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for later removal; one uniform color; no floor, scenery, shadow, gradient, texture, reflection, or lighting variation in the background.',
    `Subject: ${request.silhouette}; materials: ${request.materials.join(', ')}; equipment: ${equipment}.`,
    `Pose: ${request.pose} — ${POSE_DIRECTION[request.pose]}.`,
    'Style/medium: deliberate native-scale pixel art with tight clusters, hard one-pixel edges, binary-looking forms, restrained gothic castle palette, and no painterly or photoreal treatment.',
    'Composition/framing: exactly one creature, strict orthographic side view facing right, centered with generous transparent-candidate padding; stable bottom-center ground contact; no perspective or three-quarter view.',
    'Lighting/mood: one stable upper-left key light, restrained cool fill, dramatic readable silhouette.',
    'Color palette: cold stone and navy shadows, burgundy or violet accents, muted metal/bone/skin, sparse gold or cold-glow highlights; do not use #00ff00 in the creature.',
    'Constraints: one pose only; one creature only; original design; crisp silhouette at small scale; consistent anatomy; no cast/contact shadow; no detached particles; no text, logo, caption, signature, watermark, frame, UI, or brand marks.',
    'Avoid: named or copied game characters, protected sprites or franchise compositions, full sprite sheets, extra limbs, cropped edges, soft antialiasing, smooth gradients, airbrushing, 3D rendering, random speckle, and baked visual effects.',
  ].join('\n');
}

export async function prepareDryRun(requestValue, options) {
  requirePlainObject(options, 'options');
  const repositoryRoot = path.resolve(requireText(options.repositoryRoot, 'repositoryRoot', 4096));
  if (!path.isAbsolute(options.stagingRoot || '')) fail('IMAGE_STAGING_PATH', 'stagingRoot must be absolute');
  const stagingRoot = path.resolve(requireText(options.stagingRoot, 'stagingRoot', 4096));
  if (isWithin(stagingRoot, repositoryRoot)) fail('IMAGE_STAGING_IN_REPOSITORY', 'stagingRoot must remain outside the repository');

  const imageGenScript = path.resolve(requireText(options.imageGenScript, 'imageGenScript', 4096));
  if (path.basename(imageGenScript) !== 'image_gen.py') fail('IMAGE_TOOL_PATH', 'imageGenScript must point to the installed image_gen.py');
  const scriptBytes = await readFile(imageGenScript);
  const request = normalizeImageRequest(requestValue);
  const requestBytes = `${canonicalJson(request)}\n`;
  const prompt = buildImagePrompt(request);
  const requestSha256 = hashBytes(requestBytes);
  const promptSha256 = hashBytes(prompt);
  const outputDirectory = path.join(stagingRoot, requestSha256);
  const outputPath = path.join(outputDirectory, `${request.enemyId}-${request.pose}-source.png`);
  const config = {
    adapter: ADAPTER_ID,
    model: GENERATION_PROFILE.model,
    size: GENERATION_PROFILE.size,
    quality: GENERATION_PROFILE.quality,
    outputFormat: GENERATION_PROFILE.outputFormat,
    pythonExecutable: PYTHON_EXECUTABLE,
    dryRunAttempts: GENERATION_PROFILE.dryRunAttempts,
    dryRunDeadlineMs: GENERATION_PROFILE.dryRunDeadlineMs,
    nonExecutingLivePolicy: {
      maxAttempts: GENERATION_PROFILE.futureLiveMaxAttempts,
      totalDeadlineMs: GENERATION_PROFILE.futureLiveTotalDeadlineMs,
      cancelGraceMs: GENERATION_PROFILE.cancelGraceMs,
      retryBackoffMs: GENERATION_PROFILE.retryBackoffMs,
    },
    publication: 'forbidden',
    mode: 'dry-run-only',
  };
  const argv = [
    imageGenScript,
    'generate',
    '--model', GENERATION_PROFILE.model,
    '--prompt', prompt,
    '--size', GENERATION_PROFILE.size,
    '--quality', GENERATION_PROFILE.quality,
    '--output-format', GENERATION_PROFILE.outputFormat,
    '--out', outputPath,
    '--no-augment',
    '--dry-run',
  ];
  return Object.freeze({
    dryRun: true,
    executable: PYTHON_EXECUTABLE,
    argv: Object.freeze(argv),
    repositoryRoot,
    stagingRoot,
    outputDirectory,
    outputPath,
    request,
    requestBytes,
    requestSha256,
    prompt,
    promptSha256,
    imageGenScript,
    imageGenScriptSha256: hashBytes(scriptBytes),
    config,
    configSha256: hashBytes(canonicalJson(config)),
  });
}

function runProcess(plan, options = {}) {
  return new Promise((resolve, reject) => {
    const outputHashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
    const outputBytes = { stdout: 0, stderr: 0 };
    const stdoutChunks = [];
    const child = spawn(plan.executable, plan.argv, {
      cwd: plan.outputDirectory,
      env: options.env || process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), GENERATION_PROFILE.cancelGraceMs).unref();
      finish(reject, Object.assign(new Error('IMAGE_DRY_RUN_ABORTED: dry run canceled'), { code: 'IMAGE_DRY_RUN_ABORTED' }));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), GENERATION_PROFILE.cancelGraceMs).unref();
      finish(reject, Object.assign(new Error('IMAGE_DRY_RUN_TIMEOUT: dry run exceeded 10 seconds'), { code: 'IMAGE_DRY_RUN_TIMEOUT' }));
    }, GENERATION_PROFILE.dryRunDeadlineMs);
    timeout.unref();
    if (options.signal) {
      if (options.signal.aborted) return abort();
      options.signal.addEventListener('abort', abort, { once: true });
    }
    for (const streamName of ['stdout', 'stderr']) {
      child[streamName].on('data', (chunk) => {
        outputBytes[streamName] += chunk.length;
        if (outputBytes[streamName] > GENERATION_PROFILE.maxCapturedBytesPerStream) {
          child.kill('SIGTERM');
          finish(reject, Object.assign(new Error(`IMAGE_DRY_RUN_OUTPUT_LIMIT: ${streamName} exceeded limit`), { code: 'IMAGE_DRY_RUN_OUTPUT_LIMIT' }));
          return;
        }
        outputHashes[streamName].update(chunk);
        if (streamName === 'stdout') stdoutChunks.push(Buffer.from(chunk));
      });
    }
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code, signal) => {
      if (finished) return;
      finish(resolve, {
        code,
        signal,
        stdoutBytes: outputBytes.stdout,
        stderrBytes: outputBytes.stderr,
        stdoutSha256: outputHashes.stdout.digest('hex'),
        stderrSha256: outputHashes.stderr.digest('hex'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    });
  });
}

function validateDryRunResponse(plan, stdout) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    fail('IMAGE_DRY_RUN_RESPONSE', 'CLI stdout must be one JSON object');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('IMAGE_DRY_RUN_RESPONSE', 'CLI stdout must be one JSON object');
  }
  const expected = {
    endpoint: '/v1/images/generations',
    model: plan.config.model,
    prompt: plan.prompt,
    size: plan.config.size,
    quality: plan.config.quality,
    output_format: plan.config.outputFormat,
    n: 1,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (response[key] !== value) fail('IMAGE_DRY_RUN_RESPONSE', `CLI response ${key} did not match the request`);
  }
  if (!Array.isArray(response.outputs) || response.outputs.length !== 1 || response.outputs[0] !== plan.outputPath) {
    fail('IMAGE_DRY_RUN_RESPONSE', 'CLI response output path did not match the request');
  }
}

async function validateDryRunWrites(plan) {
  const entries = (await readdir(plan.outputDirectory)).sort();
  if (entries.length !== 2 || entries[0] !== 'prompt.txt' || entries[1] !== 'request.json') {
    fail('IMAGE_DRY_RUN_WRITE', 'CLI dry run created an unexpected staging entry');
  }
}

async function realpathIfPresent(candidate) {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function runDryRun(plan, options = {}) {
  if (!plan || plan.dryRun !== true || !plan.argv?.includes('--dry-run')) {
    fail('IMAGE_DRY_RUN_REQUIRED', 'prototype adapter may invoke only the CLI dry-run path');
  }
  if (plan.executable !== PYTHON_EXECUTABLE || plan.config?.pythonExecutable !== PYTHON_EXECUTABLE) {
    fail('IMAGE_TOOL_INTERPRETER', `dry run requires ${PYTHON_EXECUTABLE}`);
  }
  const currentScriptSha256 = hashBytes(await readFile(plan.imageGenScript));
  if (currentScriptSha256 !== plan.imageGenScriptSha256) fail('IMAGE_TOOL_CHANGED', 'image_gen.py changed after planning');

  const resolvedRepository = await realpath(plan.repositoryRoot);
  const resolvedStaging = await realpathIfPresent(plan.stagingRoot);
  if (!resolvedStaging) fail('IMAGE_STAGING_PATH', 'stagingRoot must already exist');
  if (isWithin(resolvedStaging, resolvedRepository)) fail('IMAGE_STAGING_IN_REPOSITORY', 'resolved stagingRoot entered the repository');

  const existingOutput = await realpathIfPresent(plan.outputDirectory);
  if (existingOutput) {
    if (!isWithin(existingOutput, resolvedStaging)) fail('IMAGE_STAGING_ESCAPE', 'request directory escaped stagingRoot');
    fail('IMAGE_STAGING_EXISTS', 'request directory already exists');
  }
  await mkdir(plan.outputDirectory, { mode: 0o700 });
  const resolvedOutput = await realpath(plan.outputDirectory);
  const confirmedStaging = await realpath(plan.stagingRoot);
  if (confirmedStaging !== resolvedStaging) fail('IMAGE_STAGING_CHANGED', 'stagingRoot changed during setup');
  if (!isWithin(resolvedOutput, resolvedStaging)) fail('IMAGE_STAGING_ESCAPE', 'request directory escaped stagingRoot');

  await writeFile(path.join(plan.outputDirectory, 'request.json'), plan.requestBytes, { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(plan.outputDirectory, 'prompt.txt'), `${plan.prompt}\n`, { mode: 0o600, flag: 'wx' });

  let terminal;
  let failure;
  let dryRunResponseValidated = false;
  let dryRunWritesValidated = false;
  try {
    const processResult = await runProcess(plan, options);
    const { stdout, ...terminalFields } = processResult;
    terminal = terminalFields;
    if (terminal.code !== 0) {
      failure = Object.assign(new Error(`IMAGE_DRY_RUN_FAILED: CLI exited ${terminal.code ?? terminal.signal}`), { code: 'IMAGE_DRY_RUN_FAILED' });
    } else {
      try {
        validateDryRunResponse(plan, stdout);
        dryRunResponseValidated = true;
        await validateDryRunWrites(plan);
        dryRunWritesValidated = true;
      } catch (error) {
        failure = error;
      }
    }
  } catch (error) {
    failure = error;
    terminal = {
      code: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: hashBytes(''),
      stderrSha256: hashBytes(''),
    };
  }

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    status: failure ? 'DRY_RUN_FAILED' : 'DRY_RUN_PASS',
    adapter: ADAPTER_ID,
    requestSha256: plan.requestSha256,
    promptSha256: plan.promptSha256,
    configSha256: plan.configSha256,
    provenance: {
      model: plan.config.model,
      pythonExecutable: PYTHON_EXECUTABLE,
      imageGenScriptSha256: plan.imageGenScriptSha256,
      imageGenScriptBasename: path.basename(plan.imageGenScript),
      dryRunResponseValidated,
      dryRunWritesValidated,
      mode: 'dry-run-only',
    },
    limits: {
      dryRunAttempts: plan.config.dryRunAttempts,
      dryRunDeadlineMs: plan.config.dryRunDeadlineMs,
      maxCapturedBytesPerStream: GENERATION_PROFILE.maxCapturedBytesPerStream,
    },
    nonExecutingLivePolicy: plan.config.nonExecutingLivePolicy,
    publication: 'forbidden',
    sourceGenerated: false,
    terminal,
    failureCode: failure?.code || null,
  };
  const receiptBytes = `${canonicalJson(receipt)}\n`;
  const receiptPath = path.join(plan.outputDirectory, 'receipt.json');
  await writeFile(receiptPath, receiptBytes, { mode: 0o600, flag: 'wx' });
  if (failure) throw failure;
  return Object.freeze({
    receipt,
    receiptPath,
    receiptSha256: hashBytes(receiptBytes),
    outputDirectory: plan.outputDirectory,
  });
}
