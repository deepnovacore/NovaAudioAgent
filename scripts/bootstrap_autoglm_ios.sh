#!/bin/sh
# Create only the isolated environment used by the pinned Open-AutoGLM submodule.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
repo="$root/thirdparty/Open-AutoGLM"
venv="$root/.autoglm-venv"

if [ ! -f "$repo/requirements.txt" ]; then
    echo "Open-AutoGLM submodule is not initialized" >&2
    exit 1
fi

pinned=$(git -C "$root" ls-tree HEAD -- thirdparty/Open-AutoGLM | awk '{print $3}')
actual=$(git -C "$repo" rev-parse HEAD)
if [ -z "$pinned" ] || [ "$actual" != "$pinned" ]; then
    echo "Open-AutoGLM submodule does not match the pinned revision" >&2
    exit 1
fi

if [ ! -x "$venv/bin/python" ]; then
    python3 -m venv "$venv"
fi

"$venv/bin/python" -m pip install -r "$repo/requirements.txt"
echo "AutoGLM iOS environment ready: .autoglm-venv"
