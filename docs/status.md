# Project Status

Nova Audio Agent is an experimental open-source project at version `0.1.0`.

| Area | Status |
|---|---|
| Event-driven runtime, memory, slots, delegates, and floor | Implemented with deterministic tests |
| Simulator, search, Home Assistant, Codex, camera, Watch, and Guard adapters | Implemented |
| Qwen Audio Realtime transport and recovery | Implemented; requires provider credentials for live use |
| Ambient Orb (particle visual, Memory Board, settings panel) | Implemented; tested on macOS, and unit-tested for Windows and Linux |
| Native VoiceProcessingIO echo cancellation | Implemented on macOS; Windows and Linux use Chromium echo cancellation |
| AutoGLM iOS worker integration | Experimental; upstream submodule and device setup required; not supported on Windows |
| Packaging and CI | Python build plus Python and Electron test jobs across macOS, Linux, and Windows; unsigned installer artifacts |

The repository does not ship credentials, runtime traces, personal recordings, or live acceptance
artifacts. Hardware and provider integrations therefore require local verification by each user.

Known open work includes broader live-provider soak testing, first-run verification of the Windows
and Linux desktop builds on real hardware, native echo cancellation on those platforms, installer
signing, and expanding public examples without weakening the runtime invariants. Standalone
packaging gaps and the planned Node runtime migration are tracked in
[`node-runtime-migration/backlog.md`](archs/node-runtime-migration/backlog.md).
