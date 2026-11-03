#!/usr/bin/env bash
# Builds the repo, checks it, and puts the local `brain` binary on PATH.
#
#   pnpm local            install, build, lint, typecheck, test, link, smoke test
#   pnpm local --fast     install, build, link, smoke test (skips the checks)
#
# The full log of every step goes to .logs/local-<time>.log; the terminal shows one line per step.
# `brain` is a symlink to packages/cli/dist/index.mjs, so later builds need no relinking.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${BRAIN_BIN_DIR:-$HOME/.local/bin}"
ENTRY="$ROOT/packages/cli/dist/index.mjs"
FAST=false

for arg in "$@"; do
  case "$arg" in
    --fast) FAST=true ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$ROOT/.logs"
LOG="$ROOT/.logs/local-$(date +%Y%m%d-%H%M%S).log"
cd "$ROOT"

{
  echo "# $(date)"
  echo "# node $(node --version), pnpm $(pnpm --version), $(uname -sm)"
  echo "# commit $(git rev-parse --short HEAD 2>/dev/null || echo none)$(git diff --quiet 2>/dev/null || echo ' (uncommitted changes)')"
} >"$LOG"

STARTED=$SECONDS

# Runs one step, logging its full output; on failure prints the last lines and stops.
step() {
  local name="$1"
  shift
  local t0=$SECONDS
  printf '%-28s' "$name"
  printf '\n===== %s: %s\n' "$name" "$*" >>"$LOG"
  if "$@" >>"$LOG" 2>&1; then
    printf 'ok    %3ss\n' "$((SECONDS - t0))"
  else
    local code=$?
    printf 'FAIL  %3ss (exit %s)\n\n' "$((SECONDS - t0))" "$code"
    tail -n 40 "$LOG"
    printf '\nFull log: %s\n' "$LOG"
    exit "$code"
  fi
}

link() {
  mkdir -p "$BIN_DIR"
  ln -sfn "$ENTRY" "$BIN_DIR/brain"
  ls -l "$BIN_DIR/brain"
}

smoke() {
  local found
  found="$(command -v brain || true)"
  if [ "$found" != "$BIN_DIR/brain" ]; then
    echo "brain on PATH is '${found:-nothing}', expected $BIN_DIR/brain."
    echo "Add $BIN_DIR to PATH, ahead of any other brain."
    return 1
  fi
  brain --version
  brain --help >/dev/null
}

step "install" pnpm install --frozen-lockfile
step "build" pnpm build
if [ "$FAST" = false ]; then
  step "lint" pnpm lint
  step "typecheck" pnpm typecheck
  step "test" pnpm test
fi
step "link brain" link
step "smoke test" smoke

printf '\nDone in %ss. brain %s\nFull log: %s\n' \
  "$((SECONDS - STARTED))" "$(brain --version)" "$LOG"
