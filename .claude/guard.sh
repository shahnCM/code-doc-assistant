#!/usr/bin/env bash
cmd=$(jq -r '.tool_input.command // ""')
for pat in 'rm[[:space:]]+-rf' 'compose[[:space:]]+down.*-v' 'DROP[[:space:]]+(TABLE|DATABASE)'; do
  if [[ "$cmd" =~ $pat ]]; then echo "guard.sh blocked: /$pat/" >&2; exit 2; fi
done
