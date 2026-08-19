# Nova Audio Agent Python to Node Parity Matrix

Status: Python baseline recorded; Stage 1 foundation active and provider-neutral Stage 2 groundwork
started as of 2026-08-19.

## How to Use This Matrix

Every Python production behavior and test must end in exactly one state:

- **Fixture parity**: Python exports a versioned fixture and Node must match it exactly.
- **Node test**: language- or implementation-specific behavior is asserted directly in Node.
- **Platform acceptance**: hardware, installer, or OS behavior is verified outside deterministic
  unit tests.
- **Retired**: the capability was explicitly removed from scope and receives a migration error or
  documentation update.

No row may remain merely "not ported" when Node becomes the default. Live-model quality checks are
additional evidence, never substitutes for deterministic contract tests.

## Baseline Record

Fill this table on `rewrite/node-typescript-runtime` before changing runtime behavior.

| Check | Baseline command | Result | Count/duration |
|---|---|---|---|
| Python lint | `uv run ruff check src tests scripts` | Passed | 233 source/test/script files |
| Python format | `uv run ruff format --check src tests scripts` | Passed | 233 files already formatted |
| Python tests | `uv run pytest -q` | Passed | 2,741 tests; 62.99s isolated run |
| Python package | `uv build` | Passed | sdist and wheel built |
| Python CLI smoke | `uv run nova-audio-agent --help` | Passed | `chat`, `scorecard`, `demo`, `workspace` visible |
| Electron tests | `npm run test:desktop` | Passed | 293 tests; 2.75s cleaned-baseline Node test time |
| Electron build | `npm run build` | Passed | Runtime TypeScript and Ambient Orb validation |

Any baseline failure must be recorded with an owner and disposition. Do not encode accidental
failure output as a golden fixture.

Current checkpoint: 147 runtime tests and 299 Electron tests pass. The latest full Python run
completed all 2,764 test cases but returned failure because the deterministic phase took 3.605
seconds against its 3.500-second budget. Twenty Python-exported fixtures match Node by canonical
bytes. The compiled desktop transport, model/executor job sequencing, three single-flight slots, speech/Floor
event order, stale-action fencing, malformed-output compensation, and reclaimable delegate routing
are active. Cross-source fixture order, scripted delegate IDs, preset cooldown, negative executor
correlation, Surrogate refusal paths, Floor defer/preempt, and an executable deterministic Node CLI
are now pinned. Every FastBrain and Surrogate `ContextView` is included in expected fixture output,
including the structured-update model view. This is a core parity claim for those twenty scenarios,
not Stage 1 acceptance:
deadline request redaction, playback generation/barge-in fencing, malformed executor output, and
model-output/raw-prompt trace hygiene are covered. `CausalRuntime` owns asynchronous completion and
bounded cancellation in Node tests, but production desktop/model/provider assembly does not yet
instantiate it. The Electron utility-process smoke is also environment-blocked in the current
headless macOS sandbox.

## Core Runtime

| Behavior | Current ownership | Node evidence | Retirement gate |
|---|---|---|---|
| Event schema, ordering, deadline-last tie break | `events.py`, event queue and trace tests | Fixture parity plus Zod schema tests | Exact records, `ts`, and `seq` match |
| Trace JSONL round trip and hygiene | `trace.py`, trace replay tests | Fixture parity and Node file tests | No prompt/model raw output in traces |
| Delegate binding and identity | `delegates.py`, ports and consistency tests | Fixture parity and type-level construction tests | Model cannot supply host-owned fields |
| Runtime reducer and async dispatch | `runtime.py`, runtime/scenario tests | Fixture parity plus `CausalRuntime` task/lifecycle tests | Applied events and final state match; production assembly uses the causal loop |
| Exact deadline behavior | deadline scenario tests | Fixture parity with virtual clock | Same-instant handoff beats deadline |
| Progress and observation correlation | progress/observation runtime tests | Fixture parity | Stale or mismatched delegates are ignored |
| Structured Memory and compression | memory/compression tests | Fixture parity plus Node unit tests | Canonical entries and summaries match |
| ContextView projection | context-view tests | Fixture parity including every model-facing view | Same bounded view for same memory |
| Suggestion cooldown and re-arm | suggestion/proactive tests | Fixture parity | Same eligibility and selected suggestion |
| Floor arbitration | floor and speak/act scenarios | Fixture parity | Same allow/preempt/defer decision |
| Slots and model job completion | slot/runtime tests | Fixture parity | Stale jobs cannot mutate live state |
| Configuration and secret hygiene | config/contract-failure tests | Zod and redaction tests | Supported env behavior matches |
| Deterministic demos and scorecard fixtures | demo/scorecard tests | Node tests and fixtures | Equivalent scenario outcomes |

Scorecard and demo caveats:

- `scorecard.py` resolves `tests/snapshots/` by filename at runtime, a production-to-test-tree
  coupling. The Node port re-homes these snapshots into the versioned fixture directory.
- `scenario5_codex_status.json` and `scenario6_search_injection.json` are hand-authored and cannot
  be regenerated; they migrate by explicit versioning, never by re-export.
- `demos.py` has no test coverage today. Deterministic demos need committed fixtures before their
  row can turn green.

## Desktop and Realtime

| Behavior | Current ownership | Node evidence | Retirement gate |
|---|---|---|---|
| Readiness callback and token validation | desktop entry and Electron backend tests | Node unit and Electron integration tests | Same shape, loopback restriction, bounds |
| Single authenticated desktop client | realtime desktop tests | Node WebSocket integration tests | Duplicate/invalid clients rejected |
| Parent EOF/disconnect shutdown | desktop entry/backend tests | utility-process integration tests | Bounded drain and no owned descendants |
| Desktop input validation | realtime protocol/desktop tests | Zod schema and fuzzed-invalid-input tests | Existing accepted/rejected frames match |
| Audio/caption output ordering | desktop/playback tests | Fixture parity | Same ordering and droppable behavior |
| Playback generation fencing | playback/session/service tests | Fixture parity and renderer integration | Stale frames/captions never escape |
| Session history and recovery | history/session tests | Fixture parity | Reconnect state and replay decisions match |
| Memory recall and board projection | recall/memory-board tests | Fixture parity | Same bounded visible content |
| Telemetry and trace redaction | telemetry/evidence tests | Node unit tests | No credentials or raw protected payloads |
| Provider-neutral contract and lifecycle | realtime protocol/session tests | Zod and Node lifecycle tests for host items, events, PCM, epoch, reconnect, and close | Shared contract is used by both production adapters; full session parity remains required |
| Qwen provider protocol | realtime Qwen tests | Provider-frame fixtures plus live smoke | All deterministic cases green |
| Volcengine ASR/TTS/Ark/protocol | Volcengine component/provider tests | Provider-frame fixtures plus live smoke | All deterministic cases green |
| Streaming VAD | Volcengine VAD tests | LiveKit local VAD waveform fixtures plus native-binding startup tests | Equivalent segmentation tolerances documented on every release platform |
| Audio end-of-turn detection | turn handling, endpointing, interruption, and backchannel tests | LiveKit `TurnDetector` stream fixtures plus microphone acceptance | Local `v1-mini` is proven through a real inference executor; missing executor/native inference is explicit and bounded, never accepted via the positive default |

## Executors and Vision

| Behavior | Current ownership | Node evidence | Retirement gate |
|---|---|---|---|
| Fast/slow simulators | sim tests | Node tests and core fixtures | First vertical slice green |
| Search trust, errors, and redaction | search executor/smoke tests | Node HTTP unit tests plus optional live smoke | Same trust and safe error behavior |
| Codex JSONL and protocol parsing | Codex JSONL/protocol tests | Node parser fixtures | Exact accepted/rejected messages |
| Codex app-server lifecycle | app-server/transport/runtime tests | Node fake-process integration tests | Run/steer/cancel ordering preserved |
| Codex progress and recall | progress status/recall evals | Fixture parity plus gated live eval | Correlation and memory behavior match |
| Process tree ownership | process-tree/preflight tests | Cross-platform integration and hardware tests | Windows Job Object equivalent verified |
| Camera snapshot | camera/vision tests | Chromium capture integration | Same evidence and media-ref contract |
| Watch/Guard lifecycle | watcher/watch-alert tests | Fixture parity plus camera integration | Wake, evidence, and stop semantics match |
| Local video fixture input | vision smoke/eval tests | Chromium/WebCodecs test assets | No Python/OpenCV/system ffmpeg required |
| Home Assistant | HA unit/smoke tests | Retired-capability error tests | Source/config/docs removed at cleanup |
| AutoGLM | AutoGLM protocol/transport/smoke tests | Retired-capability error tests | Source/config/docs/submodule removed |
| GPT-live Tetris evaluation family | `evals/live_tetris.py`, `evals/trajectory.py`, gptlive tests and script | Retired: deleted by the approved pre-migration cleanup (see backlog) | `evals/tetris_artifact.py` stays with the codex-progress row |
| Realtime probe tooling | `scripts/realtime_probe/` and its tests | Retired: Stage 2 debugging aid only, never ported | Removed with the Python runtime |

## Repository and Release

| Behavior | Evidence | Gate |
|---|---|---|
| qwen-audio-agent remains reference-only | Repository guard tests | No production import or copied assets |
| Runtime ships compiled JavaScript | Package inspection | No `.ts` execution dependency |
| Installer contains runtime dependencies | NSIS/AppImage/deb/macOS inspection | Clean-machine launch succeeds |
| Python-free distribution | Package inspection and clean CI image | No Python executable, package, or bootstrap |
| Renderer security boundary | Electron security tests | Isolation, CSP, sender checks unchanged |
| Cross-platform process cleanup | CI integration plus real Windows test | No descendant remains after quit/cancel |

## Parity Is Gated in Two Halves, Not One

Nothing currently proves both directions in a single job, and it is worth being
explicit about what that means:

- `npm run test:runtime` (and `npm run runtime:fixtures`) proves **Node matches the committed
  `expected.json`**. It runs in the Electron CI leg, which does not install Python.
- `uv run pytest tests/test_runtime_fixture_oracle.py` proves **Python matches the same committed
  files**. It runs in the Python CI leg, which does not build the Node runtime.

Both halves compare against the same committed bytes, so agreement is transitive and the gate is
sound. But a fixture regenerated by one language and not re-verified by the other would pass its own
leg, and no job fails on the *pair*. Treat a fixture change as requiring both legs green in the same
commit, and never hand-edit an `expected.json`: it exists only as a Python export.

The committed `fixtures/runtime/v1/schema.json` is separately checked for drift against the Zod
contract, so a schema change cannot silently widen what either side accepts.

## Unicode Classification Is Version-pinned, Not Ambient

`valid_progress_summary` rejects characters whose Unicode general category starts with C. Python
answers that from CPython's bundled database and V8 answers `\p{C}` from ICU's, and those versions
differ: CPython 3.12.11 carries Unicode 15.0.0 while Node 24.8.0 with ICU 77.1 carries 16.0. U+1CC00,
U+1E5D0, and U+10D40 are `Cn` to Python and assigned symbols to Node, so an identical progress
summary produced divergent durable memory and divergent model-visible content.

Because committed fixtures are the permanent oracle, any predicate reading a runtime's ambient
Unicode tables makes those fixtures fragile against an ICU or interpreter upgrade. The Node runtime
now consults a generated table pinned to 15.0.0 (`scripts/generate_unicode_tables.py` ->
`runtime/src/unicode-tables.ts`). Guards on both sides fail loudly if either version moves. The nine
unported `unicodedata` call sites, including NFC/NFKC normalization that is **not practically
pinnable**, are tracked in the backlog's porting hazards.

## Source-text Guard Tests

Some Python tests assert on source text rather than behavior: the wall-clock allowlist in
`tests/test_wallclock_hygiene.py`, the literal-string assertions on `tests/conftest.py` and the CI
workflow in `tests/test_time_budget.py`, and the `inspect.getsource` assertions on
`scripts/eval_watch_alert.py`. These are Python-idiom guards, not product behavior. Their Node
evidence is lint rules and Node tests — for example a restricted-import rule for wall-clock
access — never fixture parity rows.

## Default-switch Checklist

Node may become the default only when:

- every preserved row above is green and every retired row has explicit tests and documentation;
- no parity fixture contains an unexplained normalization or ignored field;
- macOS, Linux, and Windows CI are required and green;
- all installers pass clean-machine startup and shutdown;
- Qwen, Volcengine, Codex, microphone/speaker, and Camera/Watch/Guard hardware checks are signed off;
- release notes document the Node rollback window and the removal of Home Assistant and AutoGLM.
