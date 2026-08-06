#!/usr/bin/env bash
path=$(jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$path" ] && exit 0
case "$(basename "$path")" in
  CLAUDE.md|README.md|BUILD-PLAN.md|.env|.mcp.json|settings.json|guard.sh|stop-gate.sh|protect.sh)
    echo "protect.sh: $(basename "$path") is settled. Ask before changing it." >&2
    exit 2 ;;
esac
