# Nova Audio Agent Node Runtime Migration Plan

Status: Stage 0 cleanup complete, Stage 1 foundation active, and provider-neutral Stage 2 groundwork
started as of 2026-08-19.

## Outcome

Nova Audio Agent will ship as a Node.js 22 and TypeScript application with no Python requirement.
Electron remains the desktop shell and launches the compiled runtime through
`utilityProcess.fork()`. The runtime stays outside the Electron main process so model, provider,
and executor failures cannot block window management, settings, permissions, or shutdown.

The migration is incremental. Python is the executable behavioral oracle while the Node runtime
is built, but committed language-neutral fixtures become the permanent oracle before Python is
removed. The final installer, built-in capabilities, development commands, and CI do not install
or invoke Python. The existing macOS Swift audio helper may remain as a platform-native component.

## Product Boundary

### Preserved capabilities

- Runtime event spine, structured memory, ContextView, Floor, suggestion policy, and delegate
  lifecycle.
- Qwen and Volcengine realtime voice paths, playback acknowledgement fencing, captions, recovery,
  telemetry, and memory recall.
- Codex run, status, progress, live steering, cancellation, prewarm, and process supervision.
- Search, Camera, Watch, Guard, deterministic simulators, evaluation fixtures, and the Ambient Orb.

### Retired capabilities

- Home Assistant and AutoGLM are not ported.
- During the compatibility window, selecting `ha` or `autoglm`, or supplying configuration whose
  only consumer is one of those integrations, returns a credential-safe removal error.
- Their source, tests, environment variables, documentation, and the Open-AutoGLM submodule are
  removed in the final cleanup phase, after the Node default has shipped.

### Stable interfaces

- Desktop readiness remains a one-shot authenticated callback to `127.0.0.1` and returns the same
  `{host, port, token}` shape.
- Renderer/runtime traffic remains a token-authenticated, single-client loopback WebSocket.
- Existing desktop message types and required fields keep their behavior. Additions must be new
  optional fields or separately versioned message types.
- Environment names, defaults, validation, and secret-redaction behavior remain compatible for
  all preserved capabilities.
- The Python Typer CLI is not a compatibility surface. The Node CLI will expose desktop startup,
  deterministic demos, fixture verification, and diagnostics without preserving every old flag.

## Target Repository Shape

Adopt one private root npm workspace and one lockfile. The workspace contains the existing
`desktop/ambient-orb` package and a new TypeScript runtime package. Runtime source compiles to ESM;
only generated JavaScript, source maps required for diagnostics, schemas, and production
dependencies enter installers.

The baseline toolchain is Node.js 22, npm, strict TypeScript with `NodeNext` module resolution,
Zod 4 for external contracts, `ws` for the desktop and provider boundaries, and `node:test` for
tests. The build must include type checking, linting, compiled unit tests, fixture parity, Electron
tests, and package validation. Runtime code never executes TypeScript directly in production.

The Node runtime owns these layers:

```text
Electron main
  -> utilityProcess.fork(compiled desktop entry)
     -> authenticated desktop WebSocket
     -> realtime provider adapter
     -> event/runtime spine
        -> canonical Memory -> ContextView
        -> delegate slots -> executor adapters
        -> suggestion pool -> Surrogate -> Floor -> FastBrain
     -> supervised Codex/Search/vision resources
```

## Migration Stages

### 0. Isolated branch and documented baseline

Land the approved pre-migration Python cleanup (see the backlog) on `main` first, then create
`.worktrees/node-typescript-runtime` on `rewrite/node-typescript-runtime` from that cleaned
`HEAD`, so the baseline below is recorded once, on the cleaned tree. Do not move or clean the
existing working tree. Reproduce only the pinned
qwen-audio-agent submodule change needed as a reference; unrelated staged and untracked files do
not enter the migration branch.

Before implementation, record successful or failed results for the full Python suite, Electron
suite, Python build, CLI help smoke, and current three-platform CI. Record counts and duration in
the parity matrix. A failing baseline must be classified before Node work uses it as an oracle.

### 1. Differential foundation and core vertical slice

Create the npm workspace, TypeScript runtime, compiled test path, and versioned Zod schemas. Add
injectable virtual clocks, monotonic ID factories, and scripted model/executor ports so scheduling
and generated identities are exact rather than normalized away.

Port configuration, events, trace records, typed ports, Memory, ContextView, Floor, suggestions,
delegate slots, the runtime reducer, and sim executors. The first fixture set covers asynchronous
delegation, simultaneous speech and action, exact-deadline handoff ordering, progress correlation,
proactivity, stale completion rejection, barge-in, and playback identity separation.

Add `NOVA_AUDIO_AGENT_BACKEND=python|node` as a development switch, initially defaulting to
`python`. The Node desktop entry implements readiness, authentication, single-client ownership,
bounded draining, and parent-disconnect shutdown. Electron launches it with
`utilityProcess.fork()`; it must not run in the main process.

Stage acceptance:

- Node runs the deterministic sim/demo scenarios end to end.
- Python and Node produce identical canonical fixture outputs.
- Electron can select Node, complete readiness and WebSocket authentication, surface startup
  failure, and shut the runtime down without leaving descendants.
- Python remains the product default and no installer claim changes yet.

Implementation checkpoint, 2026-08-19:

- The root npm workspace, strict ESM runtime package, virtual/real clocks, deterministic IDs,
  event queue, canonical trace, Zod fixture contracts, and repository-wide fixture discovery are
  implemented. Virtual sleeps are abortable and trace writes reject non-finite data.
- Memory, explicit structured-state updates, ContextView, Floor, suggestions, single-flight slots,
  typed delegate/manifests, the runtime reducer, and the environment-backed Python/Node development
  switch are implemented with Node unit tests. Slot state now owns active job identity and pending
  wake merging; raw model output remains in a private result table until `model_done` or
  `compress_done` is applied.
- Twenty host-level fixtures cover the original deadline, async delegation, stale FastBrain,
  malformed FastBrain, progress selection, and live-observation paths plus Surrogate silent,
  invented, and unavailable selections; observation-before-user same-time ordering; stale and
  mismatched executor decorations; custom delegate IDs; Floor defer/preempt behavior; explicit
  clock-target ingress; invalid origin rejection; deadline redaction; and playback generation
  fencing across barge-in. Scripted
  port completions carry virtual delay and accept malformed JSON shapes so model failures reach the
  reducer instead of being rejected by the fixture loader.
- The Python oracle runner now validates the committed Zod-generated JSON Schema, drives the real
  Python `Runtime`, and either checks or explicitly exports goldens. All twenty fixtures have been
  exported by Python and match Node by canonical bytes. Shared conformance vectors pin ECMAScript
  number formatting for small exponents, large integral values, negative zero, binary64 rounding,
  well-formed lone-surrogate escaping, string escaping, and code-point key order. Normal test runs
  are read-only.
- Model completions are materialized only at their virtual due time, speech start/end precede the
  owning `model_done`, executor tasks reserve their private job IDs, and same-time user ingress can
  supersede an older model action before it dispatches. Production routing reclaims a definitive
  delegate after its first handoff so duplicates cannot inherit an old awaited route. Unknown
  handoffs retain routing until one uncertainty fence is consumed or a late verdict arrives.
- The Python oracle pre-registers host stimulus groups before model timers and drains a zero-time
  virtual-clock barrier after each declared stimulus. Cross-source same-time order therefore follows
  the fixture file rather than asyncio task registration. Both runners reject duplicate executor
  configuration and invalid completion plans before runtime construction, consume the actual
  scripted delegate IDs, and preserve dispatch effect order.
- The compiled Node CLI exposes read-only fixture verification and deterministic demo execution via
  `npm run runtime:fixtures` and `npm run runtime:demo -- <scenario>`.
- `CausalRuntime` owns the asynchronous model/executor task boundary: completions re-enter through
  the event queue, user ingress resolves to the applied MemoryRef, compressor calls receive frozen
  snapshots, and shutdown aborts and boundedly awaits owned tasks. No production source constructs
  it yet; provider/model adapters and the desktop service assembly remain required.
- The compiled Node desktop entry and authenticated single-client WebSocket transport are wired to
  Electron's `utilityProcess.fork()`, with Python still the default. The explicit utility-process
  smoke is present but cannot start Electron in the current headless macOS sandbox because
  `_RegisterApplication` has no WindowServer session; this is recorded as environment-blocked, not
  passing.
- The current checkpoint has 147 passing runtime tests, 299 passing Electron tests, and Python/Node
  fixture parity for twenty scenarios. The latest full Python run completed all 2,764 test cases but
  returned failure because its deterministic phase measured 3.605 seconds against a 3.500-second
  budget; this timing gate is not recorded as green. Strict TypeScript/Python lint and format checks,
  both builds, the Python CLI smoke, and whitespace checks are rerun at each checkpoint. Stage 1 is
  not accepted: a GUI-capable Electron smoke and a production assembly that instantiates
  `CausalRuntime` with real model/provider ports are still required. Malformed executor output
  becomes a language-neutral, payload-free unknown handoff. Deadline evidence has an exact sensitive-request
  redaction fixture whose durable outputs are checked for sentinel leakage. Malformed model raw
  output is likewise absent from snapshots, and trace writes reject raw-prompt fields before bytes
  reach disk.
- The provider-neutral playback generation registry is ported with bounded renderer tombstones,
  exact provider/renderer identity fencing, bounded PCM frames, clear/done acknowledgements, and
  audible-versus-suppressed delivery evidence. A Python-exported barge-in fixture proves that late
  PCM and acknowledgements from a fenced generation cannot cross into a replacement session even
  when the provider reuses its response ID.
- ContextView `in_flight.what` now renders as
  `executor.op(<canonical-json-request>)` in both runtimes. This deliberately replaces Python
  `repr`: numbers use JSON value semantics, object keys use Unicode code-point order, strings use
  JSON escaping, and nested objects cannot inherit JavaScript's integer-key enumeration order.
  The model-visible representation is covered directly in both languages rather than hidden by
  fixture normalization.
- Provider-neutral realtime contracts and lifecycle are now implemented in TypeScript. They validate
  host items, response intents, normalized provider events, bounded aligned PCM16, strictly increasing
  session epochs, stale-event rejection, host-item confirmation identity, reconnect, and idempotent
  close. This is shared substrate, not Qwen/Volcengine adapter parity or the full Python
  `RealtimeSession`; desktop microphone audio remains deliberately unwired until the first real
  provider adapter lands.

Stage 1 status, 2026-08-19: not accepted. Two items remain.

- Production desktop assembly does not instantiate `CausalRuntime`. `desktop-entry.ts` starts the
  authenticated WebSocket, answers `desktop.ready` and `codex.state:idle`, and drops every other
  frame. No renderer traffic reaches the runtime.
- The GUI-capable Electron utility-process smoke is environment-blocked: `_RegisterApplication` has
  no WindowServer session in this headless macOS sandbox. `npm run smoke:node-backend --workspace
  @nova-audio-agent/ambient-orb` is ready to run on a real desktop session.

Review fixes landed on the foundation, each with its own gate: the reducer no longer derives its
types from the fixture contract (`effects.ts` and `fixture-host.ts` split out, proven byte-identical
across all 20 fixtures rather than by a passing suite); progress-summary classification is pinned to
Unicode 15.0.0 because CPython and ICU disagree about recently assigned code points; renderer
disconnect no longer shuts the runtime down, which had diverged from Python and broke window reload;
received PCM is copied rather than aliasing a `ws` pool buffer; the readiness handshake is bounded;
`CausalRuntime.serve` yields to the macrotask queue so a saturated event queue cannot starve socket
reads; a thrown consumption releases its model slot instead of wedging it; and one code-point
comparator orders every identity.

### 2. Realtime voice and desktop behavior

Port the shared realtime session and service behavior before provider transports. Then port Qwen
Realtime, followed by Volcengine Ark, ASR, TTS, protocol handling, and adapter behavior. Implement
voice activity and audio end-of-turn detection through the published `@livekit/agents` TypeScript
pipeline. Prefer its local `TurnDetector({ version: 'v1-mini' })` and local streaming VAD so the
normal path does not require LiveKit Cloud. Do not retain a Python VAD worker.

Port history recovery, response correlation, playback generation and acknowledgement fences,
caption ordering, memory-board projection, telemetry, reconnection, and controlled Guard
activation. Preserve the desktop protocol throughout this stage.

Stage acceptance:

- Provider frame fixtures cover normal completion, malformed frames, disconnects, retries,
  response cancellation, reconnect recovery, and credential-safe failures.
- Qwen and Volcengine each pass a separately gated live smoke test.
- Real microphone/speaker tests confirm echo cancellation, barge-in, clear/done fencing, and no
  stale assistant captions after interruption.

Stage 2 progress, 2026-08-19: the Qwen Audio Realtime adapter and its bounded WebSocket transport
are ported. The wire protocol, the Chinese session instructions, the host-item wording and role
split, the one-pending-cancel-per-epoch rule, and the provider error taxonomy are reproduced from
the Python adapter and pinned by 14 Python-exported normalization scenarios matched on canonical
bytes. `npm run runtime:smoke:qwen` passes against the live DashScope endpoint.

Two departures from Python are deliberate and documented in code. A transport close now yields the
recoverable `disconnected` provider error: Python reaches that branch only on `EOFError`, which its
own test doubles raise, while a real `websockets` peer close raises `ConnectionClosed` that its
receiver does not catch, leaving the documented reconnect path unreachable in production. And
`injectHostItem` rejects a non-positive confirmation timeout, which the neutral session layer would
otherwise let through.

Still required above the adapter: the shared realtime session and service behavior, playback
generation fencing wired to a provider, history recovery, caption ordering, memory-board projection,
telemetry, and controlled Guard activation. Desktop microphone audio stays unwired until that
assembly exists.

### LiveKit voice endpointing decision

The published `@livekit/agents@1.6.4` package contains a real audio turn detector, not only the
text/ChatContext EOU model from `@livekit/agents-plugin-livekit`. It exports
`inference.TurnDetector`; the `v1-mini` path runs locally through `@livekit/local-inference`, while
`v1` uses the LiveKit inference WebSocket and falls back to the local model. The same local native
package exposes a stateful streaming VAD. Both consume mono 16 kHz int16 PCM.

The constructor alone is not a capability probe. Outside a LiveKit job context,
`TurnDetector` has no inference executor and can return its positive default instead of a model
prediction. The executor implementation used by LiveKit jobs is internal and is not exported as a
supported standalone API. Nova must therefore integrate through a supported `@livekit/agents` job
and audio-recognition lifecycle, or leave local EOT disabled; it must not import
`@livekit/local-inference` directly, extract model weights, or copy inference code.

The local package currently publishes native binaries for macOS arm64/x64, Linux arm64/x64 glibc,
and Windows x64. Stage 2 must add installation and startup probes on every release platform, prewarm
the EOT and VAD models, and measure memory and first-turn latency. The probe must run discriminating
synthetic speech/silence inputs through the actual executor path; successful construction or a
positive default is insufficient. Unsupported platforms, a missing native binding, or a missing
executor must produce an explicit capability result and use bounded silence endpointing. Cloud `v1`
remains an optional, separately configured enhancement rather than a shipping requirement.

### 3. Executors and vision

Port Search using Node HTTP APIs and existing trust/redaction policy. Port Codex around its
structured app-server or ACP boundary, retaining run/status/steer ordering, progress correlation,
preflight, cancellation, and bounded shutdown. Renderer-controlled data may never become a shell
command; executable choices come from an allowlisted catalog.

Move Camera capture to Chromium. Add only an additive, authenticated renderer/runtime frame
message if frames must cross the existing WebSocket. Use Chromium ImageCapture/WebCodecs for live
and supported file input. The installed product must not require OpenCV, Python, or a system
ffmpeg. Port Watch and Guard on top of this capture boundary and preserve their evidence,
suggestion, wake-target, and authorization rules.

Windows process ownership is a release blocker. Use a maintained Job Object integration, a small
audited native helper, or an Agent protocol whose owner guarantees kill-on-owner-close. Killing
only the immediate Codex process is not sufficient.

### 4. Default switch and Python retirement

Switch the development default to Node only when every preserved parity row is green, all package
smokes pass, and the hardware matrix is signed off. Ship one Node-default release with the Python
implementation available only as a source-development rollback; distributed installers already
contain no Python.

In the following release, remove the Python package, tests, uv/pyproject files, Python launchers,
Home Assistant, AutoGLM, and the Open-AutoGLM submodule. Keep committed fixtures and their schema
as the regression oracle. Remove `NOVA_AUDIO_AGENT_BACKEND` when no supported Python backend
remains.

## Invariants and Failure Policy

- Delegate, provider response, utterance, and playback-generation identities are distinct and
  checked at every boundary.
- Executor progress, observations, and completion affect state only for the matching active
  delegate.
- Memory is canonical before any prompt, suggestion, recall, or speech projection.
- Floor priority and allow/preempt/defer decisions remain host-owned and cannot be raised by model
  output.
- User interruption affects the active utterance or explicitly correlated foreground work, never
  unrelated background delegates.
- Invalid external data becomes a bounded contract failure; it does not crash the event loop or
  retain raw secrets.
- Shutdown stops accepting work, drains within a documented bound, cancels remaining work, closes
  transports, and removes the complete owned process tree.

## Release Gates

- Deterministic parity is exact after canonical JSON serialization; live provider tests cannot
  waive a mismatch.
- CI is green on macOS, Linux, and Windows for type checking, lint, tests, Electron build, and
  installer creation. Windows is no longer advisory.
- Clean-machine NSIS, AppImage, deb, and macOS package launches require neither Python nor a source
  checkout.
- Hardware acceptance covers Windows mixed-DPI and microphone permissions, macOS audio helper and
  signing flows, GNOME/KDE tray and transparency fallback, Qwen/Volcengine audio, Camera/Watch/Guard,
  and Codex login/cancel/descendant cleanup.
- Documentation and release notes must continue calling existing artifacts previews until these
  gates pass.

## Reference-use Rule

`thirdparty/qwen-audio-agent` may inform npm workspace layout, Electron utility-process startup,
asar boundaries, production dependency packaging, ACP process ownership, and clean shutdown. Nova
must continue to implement its own Memory, Floor, delegate, proactivity, evidence, and speech
semantics. Production imports from the submodule remain forbidden.
