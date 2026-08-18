# Node Runtime Migration Backlog

Status: deferred on 2026-08-18 while merging `worktree-orb-crossplatform`.

## Purpose

Nova Audio Agent currently uses Electron as the desktop shell and a Python companion process as
the product runtime. The shell launcher finds a Python environment that can import
`nova_audio_agent`; Electron then starts
`python -m nova_audio_agent.realtime.desktop`. A one-shot loopback TCP callback reports
readiness, the renderer and Python runtime exchange audio and state over an authenticated loopback
WebSocket, and stdin EOF requests shutdown.

The cross-platform orb work is being merged before changing that architecture. This document keeps
the known delivery gaps and the intended Node migration together so they are not mistaken for
completed standalone installer support.

## Deferred Issues

### Standalone desktop packages do not contain the runtime

The NSIS, AppImage, deb, and macOS directory targets currently contain the Electron application,
renderer assets, tray icons, and the macOS audio helper. They do not contain Python, the
`nova_audio_agent` package, or a frozen backend executable.

Repository launchers work because they inject `NOVA_AUDIO_AGENT_PYTHON` from an existing venv or
Conda environment. Starting an installed application from the desktop bypasses those launchers and
falls back to `python` or `python3`. Therefore the current CI artifacts are packaging previews,
not standalone end-user installers.

The Node target must package the runtime entry and production dependencies inside the Electron
application and start it with `utilityProcess.fork()`, following the isolation pattern used by
qwen-audio-agent. Until that target lands, installer documentation and release notes must not claim
clean-machine first-run support.

### Windows Codex resolution is incomplete

The PowerShell launcher tries to avoid npm shims by locating a native `codex.exe`, but the probed
paths do not cover the platform package layout used by current `@openai/codex` releases. An
explicit `NOVA_AUDIO_AGENT_CODEX_BIN` also rejects `.cmd` and `.bat` while still allowing a
`.ps1` shim that `CreateProcess` cannot execute directly.

The Node runtime should use one of these bounded approaches:

- launch the supported Codex ACP adapter and let its package own Codex discovery;
- resolve an allowlisted npm command and use a shell-aware Windows spawn path;
- resolve the platform package through Node package metadata rather than guessing sibling paths.

No renderer input may become a shell command. Backend commands must continue to come from a
main-process allowlist.

### Windows bootstrap omits the vision extra

`scripts/bootstrap_backend.ps1` currently runs `uv sync --locked` without
`--extra vision`, although the desktop runtime selects the local camera by default. A clean
Windows Python environment can therefore reach the launcher and then fail when the camera stack
needs OpenCV.

A Node implementation should move desktop capture to Chromium media APIs where practical. If the
Python desktop runtime remains supported before the migration completes, the PowerShell bootstrap
must instead install the vision extra and receive a real Windows smoke test.

### Windows process-tree ownership is best-effort

The Python supervisor uses `taskkill /T`. If a leader exits before cleanup walks the tree, Windows
can orphan descendants. The robust native solution is a Job Object configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.

A Node runtime must retain whole-tree ownership. Acceptable implementations are a maintained Job
Object binding, a small audited native helper, or an external Agent protocol whose owner provides
the lifecycle guarantee. Killing only the leader is not acceptable.

### Real hardware acceptance is outstanding

The following remain release gates, not unit-test substitutes:

- Windows mixed-DPI dragging and microphone permission behavior;
- Chromium echo cancellation and barge-in with speakers and microphones;
- GNOME/KDE tray behavior, X11/XWayland transparency, and opaque fallback;
- NSIS, AppImage, and deb clean-machine first run;
- Codex login, launch, cancellation, and descendant cleanup on Windows;
- installer signing and platform warning flows.

The Windows Python CI leg remains advisory until it is made consistently green and promoted from
`continue-on-error`.

## Target Architecture

```text
Electron main process
  |
  | utilityProcess.fork()
  v
Packaged Node runtime
  |-- event/runtime spine
  |-- memory and context projection
  |-- floor and suggestion policy
  |-- Qwen Realtime transport
  |-- playback identity and acknowledgement fencing
  |-- executor adapters and process supervision
  `-- authenticated loopback WebSocket
          ^
          |
      renderer
```

The Node runtime should remain out of the Electron main process. A runtime crash or blocking
integration must not freeze window management, settings, safeStorage, tray actions, or shutdown.

TypeScript plus Zod is preferred for the runtime contracts. Generated JavaScript is what ships.
The existing renderer protocol should stay stable during migration so Python and Node backends can
run behind a development switch such as `NOVA_AUDIO_AGENT_BACKEND=python|node`.

## Behavioral Invariants

Migration is complete only when the Node runtime preserves these contracts:

- delegate, provider-response, utterance, and playback-generation identities never cross;
- executor progress or completion is accepted only for the matching live delegate;
- Floor priority and allow/preempt/defer decisions remain host-owned;
- a user barge-in never silently cancels unrelated background work;
- playback clear and completion remain fenced by renderer acknowledgements;
- memory is canonical before it is projected into prompts or suggestions;
- configuration and process errors never echo credentials;
- renderer navigation, IPC, permissions, and bootstrap remain sender-validated;
- shutdown drains active work within a bound and then removes the complete child tree.

## Migration Sequence

1. Extract language-neutral JSON fixtures for events, state transitions, provider frames, playback
   acknowledgements, and executor lifecycle traces.
2. Add a packaged Node utility-process entry that implements the existing desktop handshake and
   WebSocket protocol while the Python runtime remains the default.
3. Port configuration, clocks, events, typed ports, memory, context view, Floor, slots, and the
   runtime reducer.
4. Port Qwen Realtime session handling, playback fencing, recovery, telemetry, and caption flow.
5. Port Search and Home Assistant, then Codex using an ACP or app-server strategy selected by
   explicit compatibility tests.
6. Move camera capture toward Chromium; decide whether file-video analysis needs WebCodecs,
   ffmpeg, or a native dependency.
7. Treat AutoGLM as an optional external worker, port it separately, or drop it from the
   no-Python distribution. A strictly zero-Python installation cannot silently retain the current
   AutoGLM Python worker.
8. Run Python and Node implementations against the same deterministic traces and compare emitted
   events and state. Provider live tests must not replace this differential gate.
9. Make Node the default only after all deterministic suites, package smoke tests, and the real
   hardware matrix pass. Remove Python bootstrap and discovery only after one release with a
   documented rollback path.

## Reference Pattern

`thirdparty/qwen-audio-agent` demonstrates the relevant packaging split:

- Electron packages `server/src`, `shared`, `web/dist`, and production Node dependencies;
- the Gateway starts through Electron's Node-capable utility process;
- scripts and configuration needed by external processes live outside asar;
- external Agents are detected and installed from a main-process catalog, then connected over ACP
  stdio;
- voice-only mode does not require an external Agent.

Nova can reuse that process and packaging shape, but not substitute qwen-audio-agent's Gateway for
Nova's runtime semantics.

