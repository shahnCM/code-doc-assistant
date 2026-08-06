#!/usr/bin/env bash
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
path=$(jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$path" ] && exit 0
[[ "$path" != /* ]] && path="$root/$path"
rel=${path#"$root/"}
case "$rel" in
  CLAUDE.md|README.md|BUILD-PLAN.md|.env|.mcp.json|.claude/*)
    echo "protect.sh: $rel is settled. Ask before changing it." >&2
    exit 2 ;;
esac
