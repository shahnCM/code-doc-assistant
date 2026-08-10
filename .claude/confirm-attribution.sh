#!/usr/bin/env bash
cmd=$(jq -r '.tool_input.command // ""')

if echo "$cmd" | grep -Eq '(^|[;&|])[[:space:]]*git[[:space:]]+commit([[:space:]]|$)' \
  && ! echo "$cmd" | grep -q 'CLAUDE_ATTR_CONFIRMED=1'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Before running this commit, ask the user explicitly (yes/no) whether to include the \"Co-Authored-By: Claude ... <noreply@anthropic.com>\" trailer in the commit message. Do not decide on your own and do not reuse a past answer. Once they answer, re-run this exact git commit command prefixed with CLAUDE_ATTR_CONFIRMED=1 (e.g. CLAUDE_ATTR_CONFIRMED=1 git commit -m \"...\"), including the trailer only if they said yes."
    }
  }'
  exit 0
fi

exit 0
