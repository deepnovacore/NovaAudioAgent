# Task 4E — production desktop realtime lifecycle

## Scope delivered

- Replaced the packaged Node entry's bare `buildAssembly()` / direct `runtime.serve()` path with one
  production `buildQwenRealtimeAssembly()` graph and one `DesktopRealtime` bridge.
- Added `buildDesktopRealtimeComposition()`, which routes audio frame/clear/alert/terminal, caption,
  Codex state, and project view callbacks to the exact bridge; microphone PCM, onset, playback
  acknowledgements, memory-board requests, and clock telemetry route back through the exact service.
  A callback fired before bridge construction raises the fixed
  `desktop realtime bridge is unavailable during construction` error instead of dropping output.
- Added `RealtimeDesktopService`, the sole desktop lifecycle owner. It starts realtime before the
  listener and readiness, races external stop against `service.waitStopped()`, and shuts down in the
  fixed order `server.close -> realtime.stop -> auxiliary.close`. Concurrent/repeated runs and stops
  share one operation, every cleanup is attempted, and the first actual failure is preserved.
- Desktop and auxiliary wrapper cleanup have an injected grace and fixed
  `desktop_server_close_abandoned` / `desktop_auxiliary_close_abandoned` diagnostics. Realtime stop is
  not wrapped again because `RealtimeAssembly` and `RealtimeService` already own their bounded
  provider/runtime shutdown.
- `runDesktopEntry()` validates token/readiness before construction and maps every construction or
  lifecycle failure to the fixed credential-safe `[runtime-diagnostic] assembly_failed`. The utility
  parent message, parent-port close, stdin EOF/disconnect, SIGINT, and SIGTERM all abort one shared
  controller. Renderer disconnect remains connection-local and permits reconnect to the same live
  provider/service.
- Real wiring exposed one Task 4C API gap: `DesktopSocketBridge` required `localSpeechOnset()`, but
  `RealtimeService` did not expose it although the owned `RealtimeSession` did. The only service
  surface added is the exact proxy to `session.localSpeechOnset(speechId)`; the loopback test spies on
  that same session, so a noop or second-session mutation fails.

No Electron renderer/preload/main, Camera, Codex process/project, Volcengine, LiveKit, packaging,
HA/AutoGLM, fixture expected JSON, or parity-matrix state was changed.

## TDD evidence

Before production edits, the existing `runFromEnvironment()` was exercised with a runtime-shaped
fake and the required production order. It compiled and failed behaviorally:

```text
production lifecycle starts realtime before listener and readiness
actual:   runtime:serve, server:start, ready, server:close
expected: realtime:start, server:start, ready, server:close, realtime:stop
fail 1 / pass 0
```

The new focused suite was then added before its APIs; the build failed on the missing composition,
lifecycle, entry, and owner exports. The first implementation build revealed the real service API
gap (`RealtimeService` missing `localSpeechOnset`), retained as integration RED evidence. The exact
proxy plus production composition made the suite GREEN.

Final focused result: 9 pass / 0 fail. It covers:

- strict realtime/provider connect -> listener -> readiness ordering;
- service-self-stop and external-stop race, concurrent run/stop idempotence;
- realtime/server/readiness failure rollback;
- all-attempted cleanup order, first failure, and fixed bounded diagnostics;
- invalid entry construction with no readiness or secret/path leak;
- direct and MessageEvent-wrapped `nova.shutdown` plus parent EOF convergence;
- real authenticated loopback with one fake provider, one runtime serve, PCM and onset uplink,
  audio/caption/terminal downlink, playback acknowledgement, exact runtime memory-board projection,
  renderer disconnect/reconnect, and unchanged live provider identity;
- construction-time callback refusal before bridge assignment.

Every asynchronous wait/listener cleanup is named and bounded. The real loopback test registers an
all-attempted `t.after` cleanup so even a mutation-triggered early assertion cannot leave a listener.

## Mutation evidence

`/private/tmp/task4e-mutations.mjs` applied each mutation independently and restored the exact source
plus rebuilt dist in `finally`. All five were detected at the focused test stage; none survived or
timed out:

| Mutation | Result |
| --- | --- |
| bypass bridge audio output | detected |
| announce/listen before realtime start | detected |
| omit `service.waitStopped()` from terminal race | detected |
| short-circuit cleanup after server failure | detected |
| add a second direct `runtime.serve()` | detected |

The onset identity assertion additionally kills a noop `RealtimeService.localSpeechOnset()` proxy,
because the test observes the exact owned session method.

## Verification

| Command | Result |
| --- | --- |
| focused `desktop-realtime-service.test.js` | 9 pass / 0 fail |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm run test:runtime` | 633 pass / 0 fail |
| `npm run test:desktop` | 299 pass / 0 fail |
| `uv run pytest -q tests/test_realtime_desktop_entry.py` | 24 pass / 0 fail |
| `uv run ruff check src tests scripts` | pass |
| `uv run ruff format --check src tests scripts` | 266 files formatted |
| `uv run pytest -q` | 2848 pass / 0 fail |
| `git diff --check` | pass |

Loopback suites used approved local-listener access after the sandbox correctly refused `listen`
with `EPERM`. The first full runtime rerun exposed only a stale generated JS test left by `tsc` after
the old TS test file was removed. The same TS path is now retained as a new owner-construction test,
so incremental builds no longer depend on manually cleaning `dist`; the complete rerun passed.

## Remaining external gates

- No live DashScope/Qwen websocket was opened; `runtime:smoke:qwen` remains an external credentialed
  provider gate.
- No real microphone/speaker, macOS WindowServer/VoiceProcessingIO permission recovery, Camera,
  Watch/Guard hardware, Volcengine, installer, or Windows descendant-cleanup gate is claimed here.
- Task 5 still owns Chromium Camera and cat-sofa/file capture; later slices own app-server Codex,
  Volcengine/LiveKit, three-platform packages, and the Node-default release window.

## Fix round 1 — independent lifecycle review

This follow-up closes three Important and two Minor review findings without expanding into Electron,
Camera, Codex, provider, or packaging work.

- The production callback graph now consumes `PlaybackCompletion` through the already-reviewed
  `deliveryToEvent()` boundary. Only spoken/interrupted non-empty output posts `assistant_spoken` to
  the exact composition runtime; suppressed and empty output stays absent. The real wiring exposed a
  pre-existing reducer gap: Node accepted `assistant_spoken` but discarded it. That one reducer case
  now mirrors Python `_apply_assistant_spoken` exactly: conversation channel, event timestamp,
  `trusted_system`, `USER_PRIORITY`, and the four delivery payload fields with ordinary empty refs and
  outcome. A direct reducer test and composition-to-memory-board test protect both halves.
- `service.waitStopped()` is armed synchronously after `realtime.start()` succeeds, before listener
  startup. A settled/rejected service prevents listen and readiness; a stop during listener startup
  aborts the shared owner and starts cleanup immediately. Its rejection is attached in the same turn,
  so it cannot become an unhandled rejection while startup proceeds.
- Realtime start, listener start, and readiness announcement are phase-fenced against termination.
  Once stop wins, no later phase may advance; the outstanding phase is observed for one injected grace
  and then reported with a fixed safe `desktop_*_abandoned` diagnostic. Cleanup still runs once in
  `server -> realtime -> auxiliary` order. `announceReadiness()` keeps its numeric timeout API and now
  also accepts an AbortSignal, destroys a held TCP socket on cancellation, and returns only the fixed
  `desktop readiness announcement cancelled` error.
- Host stop-source installation is now a disposable seam. SIGINT, SIGTERM, direct/wrapped parent
  shutdown messages, parent close, plain-Node disconnect, and stdin EOF all converge on one abort
  controller. Disposal removes every exact callback and pauses stdin iff this entry resumed it.
  `runDesktopEntryWithStopSources()` performs that disposal in `finally`, including configuration
  failure and service-self-stop exits.
- Captured composition callback coverage now includes clear, alert, Codex state, project view, and
  shared clock/telemetry routing in addition to the authenticated PCM/onset/audio/caption/terminal
  loopback. Production still owns exactly one `runtime.serve()` through `RealtimeAssembly`.

### Fix-round RED/GREEN evidence

All behavior tests preceded their production edits. Representative first failures were:

```text
already-stopped service: desktop.starts actual 1, expected 0
held listener/service stop: did not settle in 250 ms
stop during realtime/listener/readiness: did not settle in 250 ms
delivery composition: onDelivery actual undefined
assistant_spoken reducer: conversation items actual [], expected one trusted delivery
readiness cancellation API: options object was not assignable to number
stop-source API: installDesktopStopSources/runDesktopEntryWithStopSources exports missing
```

After the minimal implementations, the combined focused runtime/desktop set passed 85/85, including
the real authenticated WebSocket loopback and the held readiness TCP cancellation test.

### Fix-round mutation evidence

`/private/tmp/task4e-fix-mutations.mjs` used a `finally` restore for every source mutation and rebuilt
the restored tree at the end. All seven mutations were detected; none survived and none left a source
change behind:

| Mutation | Detecting behavior |
| --- | --- |
| delivery callback computes then drops the event | exact runtime Memory/board stays empty |
| skip the pre-settled service fence | dead service opens the listener |
| replace `waitStopped()` with a never-settling promise | dead service test reaches its named bound |
| ignore terminal while a listener phase is held | bounded stop test reaches its named bound |
| restore `assistant_spoken` to a no-op | direct reducer Memory assertion fails |
| misroute clear through terminal | captured callback wire frames differ |
| omit stdin pause on disposal | stop-source cleanup assertion fails |

The original Task 4E mutation set remains relevant for readiness-before-realtime, cleanup
short-circuit, and double-serve regressions; this round adds direct protection for the newly reviewed
failure modes.

### Fix-round verification

| Command | Result |
| --- | --- |
| combined focused runtime/desktop set | 85 pass / 0 fail |
| `npm run check` | pass |
| `npm run build` | pass |
| `npm run test:runtime` | 647 pass / 0 fail |
| `npm run test:desktop` | 299 pass / 0 fail |
| `uv run pytest -q tests/test_realtime_desktop_entry.py` | 24 pass / 0 fail |
| `uv run ruff check src tests scripts` | pass |
| `uv run ruff format --check src tests scripts` | 266 files formatted |
| `uv run pytest -q` | 2848 pass / 0 fail |

The first sandboxed desktop run reproduced 14 `listen EPERM` failures and 285 passes; the identical
command passed 299/299 with the already-approved local-listener permission. No WindowServer, live
provider credential, microphone/speaker, or Camera hardware claim is added by this fix round.
