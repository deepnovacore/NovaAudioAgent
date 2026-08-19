# Nova Audio Agent Node Runtime Migration Backlog

Status: Stage 0 cleanup complete, Stage 1 foundation active, and provider-neutral Stage 2 groundwork
started as of 2026-08-19.

The decision-complete implementation sequence lives in
[`plan.md`](plan.md). Test ownership and the
Python-to-Node retirement gate live in [`parity-matrix.md`](parity-matrix.md), and the
cross-language fixture contract lives in
[`differential-fixtures.md`](differential-fixtures.md).

## Purpose

Nova Audio Agent currently uses Electron as the desktop shell and a Python companion process as
the product runtime. The shell launcher finds a Python environment that can import
`nova_audio_agent`; Electron then starts
`python -m nova_audio_agent.realtime.desktop`. A one-shot loopback TCP callback reports
readiness, the renderer and Python runtime exchange audio and state over an authenticated loopback
WebSocket, and stdin EOF requests shutdown.

The cross-platform orb work has landed. This document now keeps the known delivery gaps and the
constraints that motivated the Node migration together; the linked plan owns sequencing and
acceptance criteria. The current installer artifacts remain packaging previews until the packaged
Node runtime reaches its release gates.

## Locked Decisions

- The final product, built-in runtime, and CI toolchain require no Python.
- The existing desktop readiness and authenticated WebSocket protocols remain compatible during
  migration. Supported `NOVA_AUDIO_AGENT_*` environment variables keep their names and semantics.
- Qwen Realtime, Volcengine Realtime, Codex, Search, Camera, Watch, and Guard are migrated.
- Home Assistant and AutoGLM are retired rather than ported. Selecting either capability must fail
  with a clear removal error while compatibility code remains; it must never silently fall back.
- The CLI may be redesigned for Node. Desktop and environment compatibility are the stable public
  surfaces.
- The first implementation milestone is a switchable core vertical slice backed by deterministic
  Python/Node differential fixtures. Python remains the default only during that milestone.
- `thirdparty/qwen-audio-agent` is a pinned architecture and packaging reference. Production Nova
  code must not import it or copy its runtime semantics, UI, branding, or assets.

## Approved Pre-migration Cleanup

Executed and fully gated in the working tree on 2026-08-18. These deletions land on `main` before the migration branch
is created, so the parity baseline is recorded once, on the cleaned tree. Deleted code is backed
up to a dedicated branch first, each batch is one independently green commit against the full
Python gate (ruff check, ruff format, pytest, `uv build`, CLI smoke), and a codex-rescue review
runs after the large deletion batch and at the end. Every entry below was verified zero-reference
against the tree that already contains the Volcengine realtime and cross-platform orb merges.

- Dead code: `create_event_report_workspace` and `READ_ONLY_PREFIXES` in
  `src/nova_audio_agent/evals/event_report_fixture.py` (plus their orphaned imports), the unused
  `AMBIENT_WAKE` constant in `tests/test_delegates.py`, and the orphan fixture
  `tests/fixtures/codex_app_server/minimal_messages.json`.
- `scripts/measure_codex_prewarm.py` and `scripts/eval_gptlive_tetris.py`: referenced by no
  document, test, CI job, or other script.
- The GPT-live Tetris evaluation family: `evals/live_tetris.py`, `evals/trajectory.py`,
  `tests/test_gptlive_live_runner.py`, `tests/test_gptlive_trajectory_eval.py`, and
  `tests/fixtures/gptlive/tetris_same_turn.jsonl`. Keep `evals/tetris_artifact.py` and
  `tests/test_tetris_artifact.py`: the event-report fixture, the codex progress status eval, and
  its e2e test import them. Three docstrings that cite `evals.live_tetris` by name (in
  `evals/weather_same_turn.py`, `evals/codex_progress_status.py`, and
  `scripts/eval_codex_progress_status.py`) are reworded to stand alone.
- The unused `langchain-core` and `langchain-openai` dependencies leave `pyproject.toml` and the
  lockfile in the same commit.

The cleaned baseline is 2,741 passing Python tests and 293 passing Electron tests. Ruff check,
Ruff format check, Python build, CLI help, Electron build, and production npm audit also pass.
The execution environment used for this pass exposes `.git` read-only, so the documented backup
branch and commits remain an operator step; tracked source remains recoverable from `f452077`.

The current checkpoint has 147 passing runtime tests and 299 passing Electron tests. The latest full
Python run completed all 2,764 cases, but its deterministic phase took 3.605 seconds and tripped the
3.500-second performance budget, so the Python suite gate is not currently recorded as green. The
Node implementation includes typed Memory, ContextView, Floor, suggestion and three-slot job state
machines, reclaimable host-bound delegate routing, the reducer, exact canonical traces, abortable
virtual time, an asynchronous task-owning `CausalRuntime`, a Python-default backend switch, and the
compiled authenticated desktop entry. Twenty host-level fixtures are explicitly Python-exported
and match Node by canonical bytes through a shared generated schema and number/string conformance
vectors. The Node CLI now runs
fixture verification and deterministic demos. It does not claim Stage 1 acceptance:
the playback generation state machine and a barge-in/replacement-session fixture are now included,
and malformed executor output now has a payload-free, language-neutral contract failure fixture.
The safety fixtures pin deadline request redaction and the absence of malformed model raw output,
while the trace writer rejects raw-prompt fields before writing. Provider-neutral realtime Zod
contracts and a shared provider-session lifecycle now pin epoch monotonicity, stale-event rejection,
PCM16 bounds, host-item confirmation correlation, reconnect, and close. Stage 1 is still not
accepted: the GUI-capable Electron utility-process smoke is environment-blocked, and production
desktop/model/provider assembly does not yet instantiate `CausalRuntime`. Desktop audio stays
unwired until the first real provider adapter exists; a placeholder that silently consumes PCM is
not an acceptable milestone.

In-place Python refactors were considered and rejected: Python is the behavioral oracle and is
scheduled for removal, so duplication found by the audit is not cleaned up in Python. It becomes
the implement-once list below instead. Home Assistant and AutoGLM keep their locked retirement
sequencing and receive no further investment; `scripts/realtime_probe/` stays as a Stage 2
debugging aid and leaves with the Python runtime.

## Node Implementation Constraints from the Python Audit

### Implement once

The Python codebase duplicates these; the Node runtime and its tests must implement each exactly
once:

- Scenario evaluation harness: `codex_progress_status.py` and `weather_same_turn.py` carry a
  134-line block that differs by one timeout-prefix string (recorder, report, finding, gate, and
  scalar allow-list), and `_safe_scalar` exists three times across the evals. One shared harness
  base in Node.
- Test telemetry recorder: Python tests inline 31 copies of the same `_Telemetry` recorder. One
  shared recording fake in the Node test utilities.
- Provider-turn reset: the realtime session duplicates a 12-statement reset sequence in its two
  reconnect paths. One function in Node, with the differing Floor handling kept at the call sites.
- Null speech sink (three byte-identical copies across eval scripts) and the PCM uplink pump with
  its chunk-size and trailing-silence constants (duplicated across four scripts). One shared
  helper.
- The service-layer continuation batch-abandon loop and the urgent-owner assignment each exist
  twice. One code path in Node.

### Porting hazards

- `runtime.py` reaches every field of `memory/structured.py` through `getattr` with model-supplied
  strings; only the outer target is allow-listed. The Node port must use an explicit typed map
  validated by Zod, never reflective access, so a field rename cannot silently open or close a
  model-writable surface.
- Environment compatibility is a stable surface, but the Python sources disagree with themselves:
  `.env.example` omits seven variables documented in `docs/getting-started.md`, and
  `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` is read from `os.environ` outside `Settings`. Generate the
  Node env contract from one schema; do not copy either inconsistency.
- Snapshot re-homing (the runtime scorecard reads test snapshots by filename, and two snapshots
  are hand-authored) is tracked in the parity matrix.

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
5. Port Search and Codex using an ACP or app-server strategy selected by explicit compatibility
   tests. Retire Home Assistant and AutoGLM with explicit configuration errors and migration notes.
6. Move camera capture to Chromium media APIs and use ImageCapture/WebCodecs for supported local
   media paths; the shipped runtime must not depend on Python or a system ffmpeg installation.
7. Run Python and Node implementations against the same deterministic traces and compare emitted
   events and state. Provider live tests must not replace this differential gate.
8. Make Node the default only after all deterministic suites, package smoke tests, and the real
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
