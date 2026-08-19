# Handoff: porting the realtime session and service

Written 2026-08-19 at the end of the session that produced commits `f452077..8024695` on
`rewrite/node-typescript-runtime`. Read this before touching `realtime/session.py` or
`realtime/service.py`.

> **Superseded in part, as of `e88a836`.** Step 1 is done: the provider-frame fixture set exists as
> `fixtures/realtime/session/v1/` with sixteen scenarios, and `differential-fixtures.md` documents
> the family and the sweep that validates it. Three judgments below turned out to be wrong, and
> acting on them would cost time:
>
> 1. **The double to copy is not `FakeSocket`.** That one drives `QwenAudioRealtimeAdapter`;
>    `tests/test_realtime_qwen.py` never constructs a `RealtimeSession`. The session is driven by
>    `FakeProvider` and `make_session` in `tests/test_realtime_session.py:48-146`, whose `events()`
>    deliberately raises so the caller feeds `accept` directly.
> 2. **NFC/NFKC does not enter through reconnect or packed history.** `session.py` uses
>    `realtime/history.py`, already ported. The chain is `service.py` → `bridge.py` → `recall.py`,
>    so the decision is due at the service port, not the session port.
> 3. **Stage 2 is about a thousand lines larger than stated.** `service.py` hard-depends on
>    `realtime/bridge.py` (363) and `realtime/project_confirmation.py` (412), neither ported, and
>    the latter pulls in `recall.py` (225).
>
> The eleven scenarios listed under Step 1 became sixteen: two of the budget checks and the two
> `origin_spoken` revision cases are separately observable, five event variants fall through rather
> than six, and two guards the original list would have left indistinguishable needed their own
> scenarios. The rest of this document still holds.

## Where to work

```
cd /Users/fishwowater/sqxh/nova-audio-agent/.worktrees/node-typescript-runtime
```

Branch `rewrite/node-typescript-runtime`. `main` holds only the pre-migration Python cleanup.
The pre-rewrite Python oracle is a clean checkout at `../codex-multi-workspace` (`f452077`) --
use it for comparisons, because this worktree's Python has been deliberately modified in four
places (see "Intentional oracle changes").

A snapshot of the original uncommitted work is on `backup/rewrite-wip-20260819`. Nothing needs
it, but it exists.

## The method. Do not skip this.

Every model-visible or contract-visible surface gets a **Python-exported golden** and a gate on
**both** legs. Never a hand-written expectation. This is not ceremony; it is what caught every
real defect in this migration:

- Prompt timestamps rendered `t=1` instead of `t=1.0`, affecting every prompt.
- `json.dumps` preserved an int-versus-float distinction JavaScript cannot represent, so
  `{"score": 1.0}` rendered differently in the two runtimes.
- Python `repr` escaping was missing, so a constraint containing a newline broke the prompt's
  line structure.
- `.1f` rounds half-to-even; `toFixed` does not.
- Unicode category classification differed because CPython bundles 15.0.0 and ICU bundles 16.0.
- Object key order differed because JavaScript hoists integer-like keys.

None of those would have been caught by a test written from reading the Python.

The pattern, six times over:

```
fixtures/<area>/v1/<inputs>.json          # scenarios, hand-authored, each with a `covers` note
fixtures/<area>/v1/<inputs>-expected.json # golden, ONLY ever written by --export
scripts/<area>_oracle.py                  # drives real Python; --export writes, default checks
tests/test_<area>_oracle.py               # pytest gate on the Python leg
runtime/test/<area>.test.ts               # Node gate on the same bytes
```

Existing suites, all passing in both directions:

| Suite | Scenarios | Oracle |
|---|---|---|
| Runtime fixtures | 20 | `scripts/runtime_fixture_oracle.py check` |
| Qwen normalization | 18 | `scripts/qwen_normalization_oracle.py` |
| Prompt rendering | 7 + float + `.1f` vectors | `scripts/prompt_render_oracle.py` |
| Tool schema | 4 | `scripts/tool_schema_oracle.py` |
| Gateway requests | 5 | `scripts/gateway_request_oracle.py` |
| Compressor prompts | 3 | `scripts/compressor_prompt_oracle.py` |

## Two habits that repeatedly saved this work

**Verify every new regression test by reverting the fix and watching it fail.** Three of the
tests written in this session passed against the buggy code on the first attempt. Two reasons
recurred: the fix under test short-circuited the setup (a port's own ownership check prevented
the race from being staged), and the failure mode was a hang rather than an assertion (bound
your awaits so a wrong premise fails in seconds instead of blocking the suite).

**Never put a gate and a commit in the same shell command.** A broken build was committed that
way once, because the commit ran regardless of the gate's exit code.

## Codex review: the subagent is broken, the CLI is not

`codex:codex-rescue` returns fabricated task ids without dispatching anything -- `/codex:status`
showed "No jobs recorded" after two apparent successes. Call the companion directly:

```
node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs \
  adversarial-review --background --base f452077 --scope branch "<focused brief>"
node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs status --all
node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs result <job-id>
```

Five passes found fifteen real defects. Write a focused brief naming the files, their Python
counterparts, and what you already know is intentional -- a vague brief wastes the pass. It has
also been **wrong about specifics while right about the defect**: it claimed `Zh==` decodes to
`0x66` in Python, when Python rejects it too, on PCM16 alignment rather than base64. Verify
every stated trigger before acting on it. Its sandbox cannot write `runtime/dist`, so it never
runs the suite; treat its findings as leads, not verdicts.

## What is already ported

`runtime/src/`: canonical JSON, clock, events, trace, memory, context view, floor, suggestions,
slots, ports, effects, the reducer (`runtime.ts`), `causal-runtime.ts`, playback, prompting,
tool schema, model gateway, model adapters, calls, sims, assembly, desktop transport and
service, the Qwen adapter and its WebSocket transport, and `realtime/session-state.ts`.

`realtime/`: `protocol.ts`, `provider-session.ts`, `history.ts`, `evidence.ts`,
`memory-board.ts`, `speech-prep.ts`, `telemetry.ts`, `qwen.ts`, `qwen-transport.ts`,
`session-state.ts`.

Gates at handoff: `npm run check` clean, 273 runtime tests, 299 Electron tests, ruff clean over
249 files, 2,800 pytest cases exit 0, all six parity oracles passing, and
`npm run runtime:smoke:qwen` passing against live DashScope.

## The next task, and why it is shaped differently

`realtime/session.py` (1,584 lines) and `realtime/service.py` (3,441) are **single coupled state
machines**, not layers. The `accept` reducer alone is 230 lines whose guards reference a dozen
fields -- pending response queue, suppression set, pre-map audio buffer, armed pre-start fence,
provider turn ledger, playback registry -- and the fence, preempt, and reconnect paths call into
each other. They cannot be sliced into independently gateable units the way prompting or the
model layer could. Attempting to slice them produces something that compiles and cannot be
verified, which is the one outcome to avoid here.

### Step 1: build the provider-frame fixture set first

Before porting any of `accept`, build the differential harness for it. This is the step that
makes the rest verifiable.

Shape it like `fixtures/realtime/qwen/v1/normalization.json`, but one level up: scenarios are
**sequences of normalized provider events plus host actions**, and the golden is the resulting
session state plus the outbound provider calls plus the playback effects.

Scenarios the Python source's comments say matter, each traceable to a guard in `accept`:

- A normal response: `response_started`, audio deltas, transcript deltas, `response_terminal`.
- A tool call on a host-created response, which must be refused because host responses narrate
  an injected fact and never authorize a new tool.
- `response_started` for a response already locally fenced, and one arriving while
  `floor.state == 'user_speaking'`.
- `response_started` while an armed pre-start fence exists AND a recorded turn exists -- the
  source calls this a provider protocol violation and rejects it loudly rather than killing the
  session.
- A second `response_started` while another response owns the provider slot.
- Audio deltas arriving **before** `response_started`, which buffer into the pre-map audio
  budget, plus the case that exceeds `MAX_PREMAP_AUDIO_BYTES`.
- A response whose pending intent had `origin_spoken` and whose `user_input_revision` still
  matches, which must be suppressed because the host's played-origin proof owns audible
  acknowledgement.
- The same, where the revision no longer matches, which must not be suppressed.
- Barge-in: `local_speech_onset` mid-response, then the fence, then a late audio delta from the
  fenced generation.
- Reconnect: a new epoch, then an item id from the old epoch that must not satisfy dedup.
- Guard reconnect with packed history recovery.

Drive it through the real `RealtimeSession` on the Python side with a scripted provider double
(there is one to copy in `tests/test_realtime_qwen.py`, `FakeSocket`), export the golden, then
port `accept` against it.

### Step 2: port in this order

1. **Pending response queue, suppression set, pre-map audio buffer.** Bounded, and the bounds
   matter: `MAX_PREMAP_AUDIO_BYTES`, `MAX_PENDING_HOST_EVENTS`.
2. **`accept`**, guard by guard, against the fixture set from step 1.
3. **Fence and preempt**: `host_preempt`, `_fence_and_cancel_active_response`,
   `_fence_pending_response`, `arm_next_response_fence`, `take_fence_interruption`.
4. **Playback acknowledgement**: `playback_started/done/cleared/stopped`, `complete_playback`.
   `runtime/src/playback.ts` already owns the generation registry; this is the session's side.
5. **Reconnect and recovery**: `reconnect`, `reconnect_for_guard`, packed history.
6. **`service.py`** last. It sits above the session and routes tool calls into the runtime.

### Step 3: what "done" means for Stage 2

Desktop microphone audio and renderer control frames are still not routed into the runtime, on
purpose. `desktop.ts` validates and forwards them; nothing consumes them yet. Wiring them
requires the session from step 2. **Do not add a placeholder that consumes PCM** -- the plan
calls that out specifically as a milestone that looks like progress and is not.

## Intentional oracle changes: do not "fix" these back

The Python in this worktree differs from `f452077` in four deliberate ways, all in commit
`9e13776` and the prompting commits:

1. ContextView `in_flight.what` renders `executor.op(<canonical-json>)`, not Python `repr`.
2. Origin-ref rejections are stable identifiers (`invalid_origin_ref`, `origin_not_found`,
   `origin_not_visible`), not Chinese prose containing the offending ref.
3. Executor conversion failures are one payload-free `ExecutorContractError`, not the concrete
   CPython exception name.
4. Every prompt-bound serialization routes through `canonical_json.prompt_json`, which keeps
   `json.dumps` separators but applies ECMAScript number rules and code-point key order.

In each case **Python was changed to meet Node**, because the alternative was unreproducible.
`delegates.py`'s error strings were reproducible and were changed anyway, for maintainability and
because the old form echoed model-supplied text into durable memory; the user approved keeping
that.

## Three defects that are latent in the Python oracle

Fixed on the Node side only, with the divergence documented in `backlog.md`. If Python outlives
the migration, it needs these too:

1. The recoverable `disconnected` provider error is **unreachable in production**. `qwen.py`'s
   receiver catches `EOFError`, which only its test doubles raise; a real `websockets` peer close
   raises `ConnectionClosed`, which that receiver does not catch, so `events()` ends without ever
   emitting the event `service.py` keys `_reconnect_provider_session` off.
2. A throwing speech sink **strands a Floor reservation**. `calls.py` calls `close_floor` after
   its streaming loop with no `try/finally`, so `speak_start` is posted with no matching
   `speak_end` and every later equal-or-lower-priority utterance defers forever.
3. The adapter event queue is **unbounded** (`asyncio.Queue()` with no maxsize).

## Hazards recorded in backlog.md that will bite step 2

- **NFC/NFKC normalization is not practically reproducible.** `String.prototype.normalize`
  follows the host ICU; matching CPython exactly means vendoring a normalization table. Six
  Python call sites use it, including `realtime/recall.py` and the Codex transports. **Decide
  vendor-versus-tolerance before porting recall.**
- `str.isprintable()` has no JavaScript equivalent and must be reimplemented against the pinned
  Unicode table, not approximated.
- Unicode category checks must use `runtime/src/unicode-tables.ts`, never a `\p{...}` escape.

## The one thing only a human can close

Stage 1 has a single remaining blocker. It needs a real desktop session, because
`_RegisterApplication` has no WindowServer here:

```
npm run smoke:node-backend --workspace @nova-audio-agent/ambient-orb
```

It is not recorded as passing until someone runs it. Everything else in Stage 1 is green.

## Remaining scope, honestly

About 23,000 Python production lines remain; 6,600 are ported and 6,600 are retired or out of
scope. After the session and service, the largest blocks are the Codex executor family
(~5,600 lines across `codex_app_server.py`, `codex_projects.py`, `codex_transport.py`,
`codex.py`, `codex_preflight.py`), the rest of `runtime.py`'s reducer surface,
camera and watcher, and `assembly.py`'s executor zoo.
