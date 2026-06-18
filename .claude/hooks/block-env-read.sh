#!/usr/bin/env bash
# PreToolUse hook: deny Read/Grep access to .env files (secrets).
# Reads the hook payload (JSON) on stdin and inspects the path the tool is
# about to touch — Read uses `file_path`, Grep uses `path`. If the basename
# is `.env` or `.env.*` (e.g. .env.local), exit 2 to block the call — stderr
# is fed back to Claude as the reason; otherwise allow the call through.
payload=$(cat)
path=$(jq -r '.tool_input.file_path // .tool_input.path // empty' <<<"$payload")
[ -z "$path" ] && exit 0

base=$(basename "$path")
case "$base" in
  .env | .env.*)
    echo "Reading .env files is blocked by a PreToolUse hook — they hold secrets." >&2
    exit 2
    ;;
esac
exit 0
