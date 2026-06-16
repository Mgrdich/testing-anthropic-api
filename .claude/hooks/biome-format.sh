#!/usr/bin/env bash
# PostToolUse hook: format the file Claude just wrote/edited with Biome.
# Reads the hook payload (JSON) on stdin, extracts the touched file path, and
# runs `biome check --write` on just that file. A no-op for files outside
# biome.json's scope (markdown, configs) so it never blocks an unrelated edit.
file=$(jq -r '.tool_input.file_path // empty')
[ -z "$file" ] && exit 0
bunx biome check --write --no-errors-on-unmatched --files-ignore-unknown=true "$file"
