#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if not args or args[0] != "generate" or "--dry-run" not in args:
    print("fixture accepts only generate --dry-run", file=sys.stderr)
    raise SystemExit(2)
for option in ["--model", "--prompt", "--size", "--quality", "--output-format", "--out"]:
    if option not in args or args.index(option) + 1 >= len(args):
        print(f"missing {option}", file=sys.stderr)
        raise SystemExit(2)
print(json.dumps({
    "endpoint": "/v1/images/generations",
    "model": args[args.index("--model") + 1],
    "prompt": args[args.index("--prompt") + 1],
    "n": 1,
    "size": args[args.index("--size") + 1],
    "quality": args[args.index("--quality") + 1],
    "output_format": args[args.index("--output-format") + 1],
    "outputs": [args[args.index("--out") + 1]],
    "outputs_downscaled": None,
}, indent=2, sort_keys=True))
