# Project Status

Nova Audio Agent is an experimental open-source project at version `0.1.0`.

Node.js and TypeScript are the primary source and packaged-candidate runtime. Repository
implementation does not imply a finished signed distribution.

| Area | Repository state |
|---|---|
| Runtime, memory, causal dispatch, Floor, demos, scorecard | Implemented and deterministically tested in Node |
| Search, Camera, Watch, Guard | Unconditionally assembled in Node; live camera evidence remains external |
| Codex | Node production architecture is app-server-only; JSONL is fixture-parser-only |
| Qwen and Volcengine | Provider-neutral Node assembly exists; credentials and live smokes remain external |
| HA/AutoGLM | Retired; legacy settings fail safely before construction |
| Desktop | Node runtime wired through the authenticated Electron bridge |

Repository commands for configuration fixtures, product fixtures, deterministic demos, scorecard,
and offline diagnostics are documented in the [getting-started guide](getting-started.md).

## Pending external evidence

- built-artifact dependency/resource inventory and compiled runtime/native helper placement;
- NSIS, AppImage/deb, and macOS clean-machine startup/shutdown;
- real Qwen, Volcengine, Codex login, microphone/speaker, Camera, Watch/Guard, and WindowServer use;
- Windows descendant cleanup, signed/notarized candidate evidence, and publication;
- publication of the signed Node-default release.
