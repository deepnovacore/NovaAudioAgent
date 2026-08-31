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
| Desktop | Node runtime wired through the authenticated Electron bridge; packaged builds refuse the Python backend |
| Platforms and packaging | win32/darwin/linux code paths and macOS/NSIS/AppImage+deb targets exist; the automatic unsigned workflow builds and installed-smokes Windows on main and version tags, then publishes tag builds to GitHub Releases; the manual release-candidate workflow spans macOS/Windows/Ubuntu with signing gates on its macOS and Windows legs (Linux artifacts are format-checked, not signed) |
| Codex Workspaces and Sessions | Two-level Workspace/Session store, per-workspace Codex homes, and the voice propose-and-confirm surface implemented; desktop settings expose the active workspace, the managed root, and open/clear actions behind two confirmations; voice creates managed directories only |
| Workspace memory graph | Implemented and opt-in (disabled by default), Node runtime only; episodic session summaries not built |
| MyContext provider | Loopback-only read-only client boundary only; no Nova-compatible adapter exists, so enrichment is not yet functional end to end |

Repository commands for configuration fixtures, product fixtures, deterministic demos, scorecard,
and offline diagnostics are documented in the [getting-started guide](getting-started.md).

The Settings Panel stores one key per platform and conditionally exposes integrated or cascaded
nodes. Key values are write-only and renderer-visible state is presence-only. Panel edits are held
as drafts until an explicit save, which writes them and performs exactly one controlled backend
restart, so pipeline changes take effect on that restart rather than mid-session. Live provider
smoke remains opt-in and pending external evidence.

## Pending external evidence

- built-artifact dependency/resource inventory and compiled runtime/native helper placement;
- NSIS, AppImage/deb, and macOS clean-machine startup/shutdown;
- real Qwen, Volcengine, Codex login, microphone/speaker, Camera, Watch/Guard, and WindowServer use;
- Windows descendant cleanup, signed/notarized candidate evidence, and publication;
- publication of the signed Node-default release.
