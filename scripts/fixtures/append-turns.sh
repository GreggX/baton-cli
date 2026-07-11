#!/usr/bin/env bash
# T016 — Replay growth turns into a fixture workspace's transcript.
#
# Usage: scripts/fixtures/append-turns.sh <workspace-dir> [interval-seconds]
#
#   workspace-dir     a replayable fixture workspace (tests/fixtures/ws-growing or
#                     tests/fixtures/ws-decisions)
#   interval-seconds  delay between appended turns (default 0.15) so a running
#                     `baton context watch` observes each turn as fresh activity
#
# The transcript is first RESET to its pristine base copy
# (tests/fixtures/growth/<ws>.base.jsonl), then the growth turns from
# tests/fixtures/growth/<ws>.turns.jsonl are appended one line at a time.
# Replays are therefore idempotent. Honors BATON_CLAUDE_DIR (default:
# tests/fixtures/claude under the repository root).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <workspace-dir> [interval-seconds]" >&2
  exit 2
fi

ws="$(cd "$1" && pwd)"
interval="${2:-0.15}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
claude_dir="${BATON_CLAUDE_DIR:-$repo_root/tests/fixtures/claude}"
# Resolve a relative BATON_CLAUDE_DIR against the current working directory.
case "$claude_dir" in
  /*) ;;
  *) claude_dir="$(pwd)/$claude_dir" ;;
esac

ws_name="$(basename "$ws")"
encoded="${ws//\//-}"
project_dir="$claude_dir/projects/$encoded"
base_file="$repo_root/tests/fixtures/growth/$ws_name.base.jsonl"
turns_file="$repo_root/tests/fixtures/growth/$ws_name.turns.jsonl"

if [[ ! -d "$project_dir" ]]; then
  echo "error: no fixture transcripts at $project_dir — run: npx tsx scripts/fixtures/generate-fixtures.ts" >&2
  exit 1
fi
if [[ ! -f "$base_file" || ! -f "$turns_file" ]]; then
  echo "error: $ws_name is not a replayable fixture (expected $base_file and $turns_file)" >&2
  exit 1
fi

transcript=""
for candidate in "$project_dir"/*.jsonl; do
  transcript="$candidate"
  break
done
if [[ -z "$transcript" || ! -f "$transcript" ]]; then
  echo "error: no transcript found in $project_dir" >&2
  exit 1
fi

# Reset to the pristine base, then replay the growth turns one at a time.
cp "$base_file" "$transcript"
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  printf '%s\n' "$line" >>"$transcript"
  sleep "$interval"
done <"$turns_file"

echo "replayed $(grep -c . "$turns_file") turns into $transcript" >&2
