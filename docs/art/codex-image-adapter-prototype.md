# Codex image adapter prototype

- **TD task:** `td-ac4b.5.3.1`
- **Parent:** blocked production task `td-ac4b.5.3`
- **Art profile:** [`gothic-pixel-v1`](./gothic-pixel-art-spec-v1.md)
- **Status:** non-publishing dry-run prototype

This prototype turns one bounded enemy/pose JSON request into one deterministic prompt and exercises the installed Codex image-generation CLI's `--dry-run` path. It proves request validation, prompt shaping, tool/model provenance, budgets, staging isolation, and sealed receipts without making a network request or generating an image.

It intentionally cannot publish to game content, perform a live API request, normalize raster bytes, validate pose consistency, assemble a pack, or change runtime behavior. Those remain separate reviewed tasks.

## Request

A request uses `coin-rush-image-request/v1` and contains:

- a lower-case ASCII `enemyId` slug;
- exactly one of `idle`, `move`, `attack`, `hit`, or `death`;
- bounded creature and silhouette descriptions;
- one to six unique bounded material descriptions;
- optional bounded equipment text.

Unknown keys, URLs, traversal tokens, control characters, unsafe slugs, unrecognized poses, full-sheet requests, and named/copying language fail closed.

See [`crypt-sentinel-idle.request.json`](../../test/fixtures/imagegen/crypt-sentinel-idle.request.json) for the accepted fixture.

## Dry run

The staging directory must be absolute and outside the repository:

```sh
npm run asset:pose:dry-run -- \
  --request test/fixtures/imagegen/crypt-sentinel-idle.request.json \
  --staging-dir /tmp/coinrush-imagegen-staging \
  --dry-run
```

The adapter pins `gpt-image-2`, `1024x1024`, medium quality, PNG output, and the installed `image_gen.py` bytes. The prompt asks for one original right-facing gothic-medieval key pose on a flat chroma-key background, with the accepted silhouette, lighting, small-scale pixel treatment, and no copied franchise art, text, watermark, scenery, sheet, or baked VFX.

Each request gets a private mode-`0600` directory containing canonical `request.json`, exact `prompt.txt`, and `receipt.json`. The receipt records request/prompt/config/tool hashes, the enforced one-attempt/ten-second dry-run limit, a separately labelled non-executing live retry/cancel policy, and only digests and byte counts for CLI output. It never records environment values or credentials.

The prototype refuses any invocation without `--dry-run`; a successful receipt explicitly records `sourceGenerated: false` and `publication: forbidden`.
