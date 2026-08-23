# Project Status

Nova Audio Agent is an experimental open-source project at version `0.1.0`.

Node.js and TypeScript are the primary source and packaged-candidate runtime. Repository
implementation does not imply a finished signed distribution.

| Area | Repository state |
|---|---|
| Runtime, memory, causal dispatch, Floor, demos, scorecard | Implemented and deterministically tested in Node |
| Search, Camera, Watch, Guard | Unconditionally assembled in Node; live camera evidence remains external |
| Codex | Node production architecture is app-server-only; JSONL is fixture-parser-only |
| Audio pipelines | Integrated Qwen is default; cascaded defaults to Volcengine ASR -> Qwen `qwen-flash` -> Volcengine TTS, with Ark an explicit cascaded LLM |
| HA/AutoGLM | Retired; legacy settings fail safely before construction |
| Desktop | Node runtime wired through the authenticated Electron bridge |

Repository commands for configuration fixtures, product fixtures, deterministic demos, scorecard,
and offline diagnostics are documented in the [getting-started guide](getting-started.md).

The Settings Panel stores one key per platform and conditionally exposes integrated or cascaded
nodes. Key values are write-only and renderer-visible state is presence-only; pipeline changes take
effect on the next launch. Live provider smoke remains opt-in and pending external evidence.

## Pending external evidence

- built-artifact dependency/resource inventory and compiled runtime/native helper placement;
- NSIS, AppImage/deb, and macOS clean-machine startup/shutdown;
- real Qwen, Volcengine, Codex login, microphone/speaker, Camera, Watch/Guard, and WindowServer use;
- Windows descendant cleanup, signed/notarized candidate evidence, and publication;
- publication of the signed Node-default release.
