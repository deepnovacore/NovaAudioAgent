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

The current checkpoint has 186 passing runtime tests, 299 passing Electron tests, 2,782 passing
pytest cases with exit 0, and Ruff clean over 241 files. Twenty runtime fixtures and fourteen Qwen
normalization scenarios are Python-exported and matched by Node on canonical bytes, in both
directions. The Qwen Audio Realtime adapter, its bounded WebSocket transport, and a live DashScope
smoke are landed. Review fixes since the foundation landed are listed in the parity matrix
checkpoint. Stage 1 acceptance is still open on two counts: production desktop assembly does not
instantiate `CausalRuntime`, so no renderer traffic is served, and the Electron utility-process
smoke stays environment-blocked. Desktop audio remains unwired above the adapter; a placeholder that
silently consumes PCM is not an acceptable milestone.

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

### Corrected divergences in the ported session ledgers

The ledgers landed by `a7687f1` were gated by hand-written Node expectations rather than a
Python-exported golden, and six of those expectations described behavior the oracle does not have.
None would have been caught by reading the Python; all six were fixed and each is now pinned by a
test that fails when the fix is reverted.

1. `openProviderTurn` rebuilt the entry on every call. `_record_provider_turn` returns an
   already-recorded turn untouched, so a port of `_mark_locally_fenced` -- which is exactly
   `_record_provider_turn(id).locally_fenced = True` -- would have revived a `cancel_requested` or
   terminal turn as `active`, and re-dated a stale turn against the current input revision.
2. Eviction was insertion-ordered. Python touches `move_to_end` on every access, so eviction is
   oldest-*touched* first. A JavaScript `Map` reproduces `OrderedDict` here: `delete` + `set` is
   `move_to_end` and the first key is the eviction candidate.
3. `_responded_event_ids` is keyed by bare event id, not by `(epoch, id)`: a host event the host
   already answered stays answered across a reconnect, because the host owns that identity. It also
   needs withdrawal, which the epoch ledger could not express, and its bound is enforced by a
   separate prune step rather than on record.
4. Appending a spoken or interrupted event id published a snapshot version of its own. Callers
   append a whole response's ids in a loop and publish once, so the version was counting how many
   ids a response happened to carry.
5. `beginEpoch` cleared captions, which `connect` does not; captions are reset by the layer above.
6. `truncateCaption` kept a caption's *first* 160 code points. `caption_for` bounds with
   `[-MAX_CAPTION_CHARS:]`, keeping the newest end, because a caption accumulates from deltas and
   the display has to follow what is being said now. The progress-summary bound runs the other way
   (`[:PROGRESS_SUMMARY_LIMIT]`), which is what makes the mistake easy; both directions are now
   pinned by tests that build strings of distinct code points.

### Corrected divergence in the inbound provider audio domain

`responseAudioDeltaSchema` refused a provider audio delta larger than 64 KiB.
`ResponseAudioDelta.__post_init__` requires only non-empty PCM16 alignment, and
`PlaybackRegistry.push_audio` is built for larger deltas: it splits one into
`MAX_PLAYBACK_FRAME_BYTES` frames, a loop that only ever runs above that size. The Node bound
narrowed the accepted domain on one leg and made both that split and the session's pre-map budget
check-before-the-turn-is-recorded unreachable from the provider path. It is removed; the bound on
what we *send* stays, which is a different direction with its own reason, and is in any case
already enforced at the desktop boundary where Python enforces it.

`MAX_DESKTOP_PCM_BYTES` equals `MAX_PLAYBACK_FRAME_BYTES` on both legs, so the adapter-level
outbound check never fires for audio that came through the desktop boundary. It stays as
defence-in-depth.

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
- Floor arbitration timing across a streaming call. Resolved. `calls.py` consults the Floor
  at the first non-empty text chunk, deliberately: at stream start it is not yet known
  whether there is anything to say, and a `(none, delegate)` turn would burn a Floor turn
  while `preempt` would cut off someone else's utterance for not one word. `CoreRuntime` now
  exposes `openFloor`/`closeFloor` with the oracle's three-step semantics -- decide, post the
  event so the transition stays replayable, then claim an in-place reservation so a
  concurrently compiled `surrogate.watch` view cannot read `floor=idle` while text is already
  streaming -- and `prepareSpeech` steps aside for a job a streaming port already arbitrated.
  Without that guard the re-decision reclassified speech that had already been voiced as
  deferred, filing it in the suggestion pool instead of the conversation channel; a
  regression test pins the observable. The scripted fixture path is untouched and all 20
  scenarios remain byte-identical, which is how the change was verified.
- Prompt number and string spelling. `json.dumps` preserves the int-versus-float
  distinction it parsed and Python `repr` has its own escaping, neither of which JavaScript
  can reproduce from parsed JSON. A payload that arrived as `{"score": 1.0}` renders `1.0`
  under `json.dumps` and `1` in Node; `-0.0`, `1e+16`, and `1e-05` diverge the same way.
  Resolved by routing every prompt-bound serialization through
  `canonical_json.prompt_json`, which keeps `json.dumps` separators but applies ECMAScript
  number rules and code-point key order, so the model-visible bytes are language-neutral by
  construction. Timestamps interpolated with f-strings keep Python `str(float)` because
  those fields are typed `float` and therefore deterministic, and the media age keeps
  Python's `.1f` half-even rounding, which `toFixed` does not implement. All three are
  pinned by exported vectors.
- Floor release on a failing stream or sink. `calls.py` calls `close_floor` after its
  streaming loop with no `try/finally`, so a sink that raises mid-utterance, or a provider
  iterator that rejects after the first chunk, leaves `speak_start` posted and the Floor
  reserved with no matching `speak_end`. Every later equal-or-lower-priority utterance then
  defers forever against a stale active utterance, and the trace keeps an unmatched event.
  The Node port repairs this: release happens in a `finally`, only when the Floor was
  actually acquired, and a release that itself fails never masks the original cause. Six
  tests cover emit, end, iterator, pre-speech, deferred, and failing-release paths. This is
  a deliberate departure -- the oracle has the same gap -- and it is listed here so the
  Python side can be fixed too if it outlives the migration.
- Unicode database version skew. Python classifies and normalizes characters with the database
  bundled into CPython; V8 does so with the database bundled into ICU. Those versions differ and
  drift with every release. Measured on the development machine: CPython 3.12.11 carries Unicode
  15.0.0 and Node 24.8.0 with ICU 77.1 carries Unicode 16.0, so U+1CC00, U+1E5D0, and U+10D40 are
  `Cn` to Python and assigned symbols to Node. Because committed fixtures are the permanent oracle,
  any predicate reading a runtime's ambient Unicode tables makes those fixtures fragile against an
  ICU or interpreter upgrade. The one ported instance
  (`valid_progress_summary`) is fixed: `scripts/generate_unicode_tables.py` emits a pinned
  15.0.0 category table that `runtime/src/events.ts` consults instead of `\p{C}`, and tests on both
  sides fail loudly if either version moves. Nine call sites remain unported and must not silently
  inherit the hazard:

  | Python site | Dependency | Node porting note |
  |---|---|---|
  | `ports.py` category check | `unicodedata.category` | Done: pinned table |
  | `executors/watcher.py`, `executors/codex_projects.py` (×2), `executors/codex_app_server.py`, `realtime/project_confirmation.py` | `unicodedata.category` | Reuse the pinned table; never `\p{...}` |
  | `executors/search.py` | `category in {"Cc","Cf"}` | Needs a pinned Cc/Cf subset, not the whole C set |
  | `realtime/recall.py`, `executors/codex_projects.py`, `executors/codex.py`, `executors/codex_transport.py`, `executors/codex_app_server.py` (×2) | `unicodedata.normalize` NFC/NFKC | **Not practically pinnable.** `String.prototype.normalize` follows the host ICU. Reproducing CPython's normalization exactly means vendoring a normalization table. Either accept a documented tolerance for characters whose decomposition changed between versions, or vendor the table. Decide before porting recall or the Codex transports. |
  | `executors/codex.py` | `str.isprintable()` | No JavaScript equivalent. Python's rule is "not Cc, Cf, Cs, Co, Cn, Zl, Zp, or Zs except U+0020". Must be reimplemented explicitly against the pinned table, not approximated. |
  | `realtime/recall.py` | `str.lower()` | Python full lowercase and JavaScript `toLowerCase` agree for nearly all input but not all; if recall matching is contract-relevant, pin the cases that matter with fixtures. |

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
