# 6. Verification

The deterministic suite verifies event ordering, deadlines, identity fencing, memory-before-speech,
tool-schema authority, untrusted evidence handling, realtime correlation, playback acknowledgement,
and desktop isolation.

Adapter consistency tests apply the same contract checks to every production executor. Live smokes
are separate because they require credentials, devices, or network services and must never be
mistaken for CI evidence.

The public verification commands are:

```bash
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
uv build
(cd desktop/ambient-orb && npm test && npm run build)
```
