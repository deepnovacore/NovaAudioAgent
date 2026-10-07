#!/usr/bin/env bash
set -euo pipefail

spec="$1"
prefix="$2"
mkdir -p "$prefix"
log="$prefix/npm-install.log"
for attempt in 1 2 3 4 5; do
  if npm install --registry https://registry.npmjs.org --prefix "$prefix" "$spec" > "$log" 2>&1; then
    cat "$log"
    exit 0
  else
    status=$?
  fi
  # A missing dependency or authentication/network failure is not propagation delay.
  if ! grep -Eq 'code (ETARGET|E404)' "$log" || ! grep -Fq "$spec" "$log"; then
    cat "$log" >&2
    exit "$status"
  fi
  if test "$attempt" -lt 5; then sleep 30; fi
done
cat "$log" >&2
exit "$status"
