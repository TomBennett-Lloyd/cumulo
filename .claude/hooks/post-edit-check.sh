#!/usr/bin/env bash
# PostToolUse hook: immediate ESLint feedback on any edited TypeScript file,
# so implementing agents self-correct instead of leaving issues for review.
set -u
export PATH="/opt/homebrew/bin:$PATH"

input=$(cat)
file=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))
except Exception:
    pass
')

case "$file" in
  *.ts|*.tsx|*.mts|*.cts) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
[ -d "$root/node_modules" ] || exit 0
[ -f "$file" ] || exit 0
cd "$root" || exit 0

if ! out=$(pnpm exec eslint --no-warn-ignored --max-warnings 0 "$file" 2>&1); then
  {
    echo "ESLint failed for $file — fix the root cause; suppression comments are themselves lint errors:"
    echo "$out"
  } >&2
  exit 2
fi
exit 0
