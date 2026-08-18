#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DESKTOP_DIR="$ROOT_DIR/desktop/ambient-orb"

fail() {
    echo "error: $1" >&2
    exit 1
}

if [[ $# -ne 0 ]]; then
    fail "this launcher does not accept arguments"
fi

if [[ "$(uname -s)" != "Darwin" && "$(uname -s)" != "Linux" ]]; then
    fail "the Ambient Orb desktop app requires macOS or Linux"
fi

command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v codex >/dev/null 2>&1 || fail "Codex CLI is required"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
    fail "missing .env; run: cp .env.example .env"
fi

can_import_nova() {
    local candidate="$1"
    [[ -x "$candidate" ]] \
        && (cd "$ROOT_DIR" && "$candidate" -c 'import nova_audio_agent' >/dev/null 2>&1)
}

PYTHON_BIN="${NOVA_AUDIO_AGENT_PYTHON:-}"
if [[ -n "$PYTHON_BIN" ]]; then
    [[ -x "$PYTHON_BIN" ]] || fail "NOVA_AUDIO_AGENT_PYTHON must be an executable file"
    can_import_nova "$PYTHON_BIN" \
        || fail "selected Python cannot import nova_audio_agent; run: ./scripts/bootstrap_backend.sh"
else
    if [[ -n "${CONDA_PREFIX:-}" ]] && can_import_nova "$CONDA_PREFIX/bin/python"; then
        PYTHON_BIN="$CONDA_PREFIX/bin/python"
    elif can_import_nova "$ROOT_DIR/.venv/bin/python"; then
        PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
    elif command -v conda >/dev/null 2>&1; then
        CANDIDATE="$(
            conda run --name nova-audio-agent python -c 'import sys; print(sys.executable)' \
                2>/dev/null || true
        )"
        if can_import_nova "$CANDIDATE"; then
            PYTHON_BIN="$CANDIDATE"
        fi
    fi

    if [[ -z "$PYTHON_BIN" ]]; then
        fail "Nova Audio Agent Python environment is missing; run: ./scripts/bootstrap_backend.sh"
    fi
fi

if [[ ! -x "$DESKTOP_DIR/node_modules/.bin/electron" ]]; then
    echo "Installing locked desktop dependencies..."
    npm --prefix "$DESKTOP_DIR" ci
fi

export NOVA_AUDIO_AGENT_PYTHON="$PYTHON_BIN"
export NOVA_AUDIO_AGENT_CODEX_WORKSPACE="${NOVA_AUDIO_AGENT_CODEX_WORKSPACE:-$ROOT_DIR}"
export NOVA_AUDIO_AGENT_ENV_FILE="$ROOT_DIR/.env"

exec npm --prefix "$DESKTOP_DIR" start
