#!/usr/bin/env bash
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
for c in "npm test" "npm run typecheck"; do
  if ! out=$($c 2>&1); then
    { echo "$c failed — fix before stopping."; tail -30 <<<"$out"; } >&2
    exit 2
  fi
done
