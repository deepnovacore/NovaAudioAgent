# Project Status

Nova Audio Agent is an experimental open-source project at version `0.1.0`.

Python is still the default source oracle and source-development backend. Unpublished packaged
candidates now default to Node and reject the source-only Python rollback; repository
implementation does not imply a finished distribution. Node remains opt-in for source development.

| Area | Repository state |
|---|---|
| Runtime, memory, causal dispatch, Floor, demos, scorecard | Python-owned fixtures with Node consumers |
| Search, Camera, Watch, Guard | Unconditionally assembled in Node; live camera evidence remains external |
| Codex | Node production architecture is app-server-only; JSONL is fixture-parser-only |
| Qwen and Volcengine | Provider-neutral Node assembly exists; credentials and live smokes remain external |
| HA/AutoGLM | Retired in Node; retained only in the temporary Python source rollback |
| Desktop | Packaged candidate defaults to Node; source development defaults to Python |

Repository commands for configuration fixtures, product fixtures, deterministic demos, scorecard,
and offline diagnostics are documented in the [getting-started guide](getting-started.md).

## Pending external evidence

- built-artifact dependency/resource inventory and compiled runtime/native helper placement;
- NSIS, AppImage/deb, and macOS clean-machine startup/shutdown with no Python dependency;
- real Qwen, Volcengine, Codex login, microphone/speaker, Camera, Watch/Guard, and WindowServer use;
- Windows descendant cleanup, signed/notarized candidate evidence, and publication;
- one published Node-default release with the explicit Python source rollback.

Only the next release after that rollback window may remove the Python package/tests, uv/pyproject,
Python launchers, HA/AutoGLM source/tests/env/submodule, realtime probe, backend switch, and Python
oracle. Until then those files are intentionally present.
