# Project Status

Nova Audio Agent is an experimental open-source project at version `0.1.0`.

| Area | Status |
|---|---|
| Event-driven runtime, memory, slots, delegates, and floor | Implemented with deterministic tests |
| Simulator, search, Home Assistant, Codex, camera, Watch, and Guard executors | Implemented |
| Qwen Audio Realtime transport and recovery | Implemented; requires provider credentials for live use |
| macOS Ambient Orb and native VoiceProcessingIO helper | Implemented and tested on macOS |
| AutoGLM iOS worker integration | Experimental; upstream submodule and device setup required |
| Packaging and CI | Python build plus Python and Electron test jobs |

The repository does not ship credentials, runtime traces, personal recordings, or live acceptance
artifacts. Hardware and provider integrations therefore require local verification by each user.

Known open work includes broader live-provider soak testing, accessibility and packaging polish for
the desktop application, and expanding public examples without weakening the runtime invariants.
