#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_NAME="nova-audio-agent"

if ! command -v conda >/dev/null 2>&1; then
    echo "conda is required to bootstrap ${ENV_NAME}" >&2
    exit 1
fi

if conda env list | awk 'NR > 2 { print $1 }' | grep -Fxq "$ENV_NAME"; then
    conda env update --name "$ENV_NAME" --file "$ROOT_DIR/environment.yml" --prune
else
    conda env create --name "$ENV_NAME" --file "$ROOT_DIR/environment.yml"
fi

conda run --name "$ENV_NAME" bash -c '
    export UV_PROJECT_ENVIRONMENT="$CONDA_PREFIX"
    cd "$1"
    uv sync --locked
' -- "$ROOT_DIR"
