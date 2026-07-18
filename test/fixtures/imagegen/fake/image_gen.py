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
    "status": "dry-run",
    "model": args[args.index("--model") + 1],
    "size": args[args.index("--size") + 1],
    "output": args[args.index("--out") + 1],
}, sort_keys=True))
