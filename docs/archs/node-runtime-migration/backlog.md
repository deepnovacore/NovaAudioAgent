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

### The NFKC gap, measured

This was recorded as "not practically pinnable", with a choice between vendoring a normalization
table and accepting an undocumented tolerance. Measuring it instead
(`scripts/generate_nfkc_vectors.py`, `fixtures/runtime/unicode-nfkc-vectors.json`,
`runtime/test/unicode-nfkc.test.ts`) showed the gap is narrow, precisely bounded, and neither option
was necessary.

The divergence has one cause -- code points assigned after the pin -- and three faces. CPython 15.0.0
has never heard of them, so it does nothing to them; ICU 77.1 knows them and applies its rules.

1. **Compatibility decomposition**, thirty-six code points: outlined capitals U+1CCD6..U+1CCEF and
   outlined digits U+1CCF0..U+1CCF9, each decomposing to an ASCII letter or digit.
2. **Case mapping**, twenty-seven code points: Garay, Latin and Cyrillic capitals added in 16.0,
   which ICU lowercases and the pin leaves alone.
3. **Contextual composition**, the one that matters most and the one a per-code-point survey misses
   entirely. `U+16D63 U+16D68` are each unchanged by NFKC alone, so neither looks like a divergence --
   but ICU composes the pair into `U+16D6A` while CPython returns it untouched.

None of this is cosmetic. The decompositions and case mappings all land in `[a-z0-9]`, which is
exactly `recall.py`'s tokenizer domain, so under the host an outlined `𜳰` tokenizes as `0` and
matches a memory containing a zero where the oracle matches nothing.

`runtime/src/unicode-normalize.ts` holds back **every code point the pin calls unassigned**, decided
by the generated category table rather than by a list. That is deliberately broader than the code
points the host visibly transforms: face 3 proves no narrower rule can be right, because any pair of
newly-assigned code points could compose. Held-back characters are cut out and the runs around them
normalized separately -- not replaced by a placeholder, which cannot work at all: a placeholder has to
be a code point that cannot appear in the input, and private-use characters are legal text. An earlier
version silently corrupted any input containing U+F0000.

Use `normalizeNfkcPinned`, `toLowerPinned`, or `normalizeAndLowerPinned` for anything
contract-visible; plain `.normalize('NFKC')` and `.toLowerCase()` are fine only for text that never
leaves the process.

The claim is verified exhaustively rather than sampled: all 1,112,064 non-surrogate code points
through both pipelines, plus 261,282 adjacent pairs drawn from every unassigned block small enough to
be a real script. Zero divergences. If a future CPython adopts Unicode 16.0, the "host alone does not
agree" tests fail and the holdback can be deleted rather than carried indefinitely.

### Corrected in the port: a replayed user-start could re-arm a spent origin

`_remember_unbound_user_origin` refuses an item three ways -- already waiting, already having a
transcript, already bound to a response -- and the first Node port checked only the first. A replayed
`user_speech_started` would therefore put a *spent* item back in the queue, where a later response
could bind to it and admit a tool call citing a turn the user had moved past. That is the evidence
boundary the origin check exists to hold. It also used the wrong bound: 500 tracked tool calls rather
than the 32-item refusal budget these actually belong to.

Found by a Codex review. Two tests now cover the post-transcript and already-bound replays, and both
assert on the queue rather than on a downstream symptom -- the bridge's fall back to the most recent
transcript when a call has no bound origin is by design, so it cannot be used as the signal here.

### Corrected in the port: an abandoned task could stop the run that replaced it

`close` gives up on a task that will not stop, and a JavaScript promise cannot be cancelled, so that
task can still finish later. The first port's guard read `this.#stop` at completion time -- which after
a restart is the *replacement* controller -- found it un-aborted, and stopped a service that had
already been restarted. Each guard is now handed the controller it belongs to.

The distinction worth keeping: a *clean* return from an aborted run is an ordinary shutdown and
correctly says nothing. The guard is for the task that fails after being abandoned, which is what the
test exercises.

### Corrected in the port: `close` was still unbounded on the transport

Bounding the loops left `provider.close()` awaited unbounded, so a transport that never finishes
closing held application shutdown open forever -- exactly the failure mode a degraded transport has.
It is bounded now, with its own `shutdown_provider_close_abandoned` diagnostic.

### Corrected in the port: a stop flag that could not be listened to

The first service port carried its own stop flag exposing only `aborted` and `abort()`, on the
reasoning that it had to be resettable and an `AbortController` cannot be un-aborted. A Codex review
found the consequence: `CausalRuntime.serve` registers an abort listener on whatever it is handed
(`causal-runtime.ts:195`), so the look-alike threw `TypeError: addEventListener is not a function` --
which the task guard then reported as a provider failure. The service would have stopped on its first
`start()` against the real runtime.

Fixed by using a real `AbortController` and replacing it on each `start()` rather than resetting one.

### Corrected in the port: `close` could wait forever

Python cancels each live task before `gather`. A JavaScript promise cannot be cancelled from outside,
so the first port's `Promise.allSettled` would hang whenever a loop did not observe its abort -- and a
service that never finishes closing is worse than one that reports a task it could not stop.

Two halves to the fix. The loops all take the stop signal now, including the provider's `events()`,
because a parked stream is the *normal* state at shutdown and an iterator suspended in `await` cannot
be stopped from out here. And `close` waits with a bounded grace period, logging
`shutdown_tasks_abandoned` with a count rather than hanging, so a genuinely stuck task is named.

Both were verified by reverting each fix and watching a named test go red.

### Retracted: the continuation sweep in commit 03d9843 was not measured

That commit claims "twenty-one mutations swept, twenty-one detected". The claim is void. The sweep
script wrapped each test run in `timeout 90`, and `timeout` does not exist on this machine (no
coreutils, no `gtimeout`) -- so every run exited 127 with no output, and the script read "no result" as
"detected, the suite hung". It never ran the suite at all.

Re-measured without it, the continuation-drive mutation set stands at **6 of 14 detected**. What
survives is not a defect in the port but a hole in the scenario set: the undetected mutations need two
concurrent continuation batches, a turn in `cancel_requested`, a fenced turn, a `retryable` continuation
request, or a sync-pending member -- none of which the current fixtures produce. A second tool call in
the obvious place lands on the continuation turn itself rather than opening a second batch, so this
needs session-level fixtures rather than another event in sequence.

Two lessons, both about the harness rather than the code:

- **A sweep that cannot distinguish "tool missing" from "mutation detected" is worse than no sweep**,
  because it reports the reassuring answer. Any future sweep script must fail loudly when its own
  tooling is absent, and must read the test count rather than the absence of output.
- The same run also found that the projection golden was exercising a *reimplementation* in the test
  file rather than the service. Five projection mutations were invisible to it. The parity test now
  drives `projectRuntimeEvent` and reads what was queued.

### And then the parser had to be scoped to the root

Moving the integer check into a `JSON.parse` reviver fixed three bypasses and introduced a fourth
problem, in the opposite direction: the reviver visits *every* member, so nested renderer metadata
carrying the same field name was rejected. `{"generation_epoch":1,"meta":{"generation_epoch":1.5}}` is
forward-compatible data the oracle parses and ignores -- it reads only `value.get(field)` on the root --
and refusing it would discard valid playback acknowledgements, leaving playback state and clear
deadlines unresolved.

Found by a Codex review, asking the question I had put in my own brief. The reviver now *collects*
candidates with their holder object and judges them after the parse, keeping only those whose holder is
the returned root. Identity works because the reviver returns every value unchanged, so the object the
top-level members were revived into is the object that comes back.

Five cases cover it: a nested object decoy, a nested array decoy, both together, and -- the one that
matters most -- a nested decoy alongside an *invalid* root field, which must still be refused.

The lesson is the shape of the mistake rather than the mistake: each fix moved the check to a more
precise mechanism, and each move brought its own over-reach. A pattern was too loose about which text
counted; a reviver was too eager about which members counted.

### The integer check had to become a parser, not a pattern

The first two versions of the integer-literal check were a regex over the raw JSON text, and a Codex
review found two ways past it — after I had already found a third myself:

- **Duplicate keys.** `{"generation_epoch":1.5,"generation_epoch":1}` resolves to `1` in both parsers,
  but a pattern finds the first occurrence and refused a frame the oracle admits. (Found by asking the
  question in my own review brief.)
- **Escaped key spellings.** `"generation_\u0065poch":1.0` decodes to `generation_epoch`, so Python
  sees a float and refuses. The pattern does not match the escaped spelling, so Node accepted it.
- **Unrepresentable integers.** `9007199254740993` parses to `9007199254740992` in JavaScript, and
  `Number.isInteger` is happy with the result — so the bridge could fence a generation that is not the
  one the renderer sent. `sequence` and `played_ms` had the same silent loss.

All three are gone, because the check now runs inside `JSON.parse`'s reviver. `context.source` carries
the original literal, the reviver sees *decoded* key names, and it fires once per member with the
surviving value — so escaping and duplication are both handled by the parser rather than worked around.
The range problem is caught by comparing `String(value)` against the source: they differ exactly when
something was lost.

**A deliberate divergence:** the oracle accepts an out-of-range integer, since Python integers are
unbounded. Node refuses it. Acting on a different number than the renderer sent is worse than refusing
the frame, and a golden cannot express this because it would have to record the oracle's acceptance —
so it is a Node test with the reasoning attached.

One redundancy recorded rather than removed: the digit pattern and the round-trip comparison overlap,
since `String(1)` is `"1"` and never `"1.0"`. The pattern stays because it states the intent, and
because it is the only thing rejecting `1e0`, where the round trip agrees.

### The control frame needed the same integer-literal check as the audio header

`{"generation_epoch": 2.0}` on a `playback.done` frame was accepted by the Node port and refused by the
oracle, for the same reason as the audio header: `json.loads` makes it a float and JavaScript cannot
tell it from `2` after parsing. The check now covers the control frame's `generation_epoch` and
`played_ms`, with `null` allowed for the latter because "not reported" is a legal value.

`t_render_ms` is deliberately excluded: the oracle accepts an int or a float there and coerces with
`float()`, so both spellings are legal input.

### Measured coverage: the desktop socket bridge is 22 of 23

The bridge's queue structure is `asyncio.Queue` in the oracle and arrays here, so its tests are
Node-only -- a shared golden would compare two schedulers rather than two behaviours. The wire format
those queues carry is what the 90-case golden pins.

The one survivor: making `onCodexProject`'s dedup identity-based instead of value-based. The delivery
sync immediately after performs the same value comparison, so the outer check is a duplicate and cannot
be distinguished. Both are value-based deliberately -- the service rebuilds the view object on every
change, and identity would make every publish look new -- and a test states that directly.

### The desktop wire needed an integer-literal check the oracle gets for free

`_plain_positive_integer` refuses a non-`int`, and `json.loads` turns `1.0` into a float -- so a
renderer sending `{"generation_epoch": 1.0}` is refused by Python. JavaScript cannot tell `1.0` from
`1` after parsing, so the first Node port accepted it: the same bytes, accepted by one runtime and
refused by the other, which is exactly the interoperability failure this format exists to prevent.

The audio header's numeric fields are now checked against the header *text* before the parsed values
are read, because parsing is what destroys the spelling. Only the two integer fields, since the
identifier is a string and may legitimately contain a decimal point -- which the fixture covers.

The encode side of the same divergence is *not* expressible in a shared JSON fixture: `1.0` in the
fixture reaches JavaScript as `1`. A Node test states it directly instead, for both the epoch and the
sequence.

Family coverage: 22 of 23 mutations detected. The survivor is the `headerSize < 2` check, which is
redundant with the JSON parse -- a one-byte header fails to parse and produces the same message. Kept
because the oracle keeps it, and because it refuses before decoding, which a cheaper future header
format would still want.

### Found while porting reconnect: an acknowledgement never reached `delivered`

`_finish_semantic_acknowledgement` was not ported. Without it an acknowledgement bound to a
continuation stayed `bound` forever, so a reconnect re-queued it and the user was told the same work had
started a second time. Found by a reconnect test asserting the *absence* of a repeat, which is the kind
of assertion that only fails when something is genuinely missing.

It is ported now, with the three-way outcome intact: a completed response delivers the acknowledgement
permanently; a `fallback` binding that did not complete gets exactly one retry, because it was a host
fact of its own and losing it loses the only notice the user gets; a `continuation` binding that did not
complete goes back to pending without re-queueing, because the batch will drive it again.

### Measured coverage: family K (reconnect) is 13 of 18

The five survivors, with why nothing distinguishes them:

| Mutation | Why |
|---|---|
| Arming the source epoch after the await instead of before | Only a Guard racing the session's response-request lock can tell, and Guard is unported. |
| Demanding an activation unconditionally | Needs the source epoch cleared *during* the await -- a user speaking mid-reconnect -- which needs a controllable await point inside `session.reconnect`. |
| Leaving dead batches in the continuation queue | The drive pops abandoned batches at the head, so the filter is redundant with it. |
| Computing `needsSemanticAcknowledgement` from the disposition instead of the dispatch | No state reaches disposition `abandoned` without `dispatch === 'dispatched'` *and* an executor, so the two expressions cannot disagree. An inline recall has no executor, so its acknowledgement is null either way. |
| Overwriting a terminal batch's phase | The disposition is guarded separately (`if (final_disposition === null)`) and the batch is no longer in the queue, so the phase change has no reader. |
| Re-queueing a `delivered` acknowledgement | `#queueSemanticAcknowledgement` refuses `delivered` itself, so the caller's filter is a second guard on the same condition. |

Four of the six are redundant-by-construction and kept because the oracle keeps them. The first two are
genuinely blocked: the Guard one until family L lands, the activation one until the session exposes a
seam mid-reconnect. Both are listed here rather than left as a silent gap in a coverage number.

### Measured coverage, and the guards nothing distinguishes

Family O (runtime event projection) is at 20 of 22. The two survivors are redundant by construction and
recorded as such rather than patched around:

| Guard | Why nothing distinguishes it |
|---|---|
| `MAX_HOST_FACT_CHARS` on a projected fact | Every speech view is already cut to `SPEECH_FINAL_LIMIT` (600), so the 3000 cap is unreachable through this path. |
| The empty-`op` check in progress revalidation | The in-flight match immediately after compares the op against the delegate's, and no delegate has an empty one. |

Both are kept because the oracle keeps them, and each has a test stating the property directly.

### Coupling the family split did not predict: delivery reaches Guard

The service port was planned in three batches, with Guard (family L) and project confirmation (family
I) deferred because both are gated -- `controlled_guard_reconnect=False` and
`project_confirmation is None`. That holds for the *features*, but not for the call graph:
`_delivery_pass` calls `_maybe_preempt_locked` and `_flush_host_items_locked` calls
`_guard_overlap_allowed`, both family L.

They are reachable only when a host item is queued `preemptive`, which happens only when an executor
manifest's policy priority is at or above `PREEMPT_MIN_PRIORITY` (80). No core-path scenario configures
one, so the paths are structurally inert -- but inert is not absent, and a port that silently took the
inert branch would be indistinguishable from a correct one.

The Node port therefore reaches an explicit `NotYetPortedError` at each of those two points rather
than returning the inert answer. A scenario that gets there fails with a name. This is the reason the
delivery path can be landed before Guard at all, and the reason a future Guard scenario cannot
accidentally pass against the unported code.

### Corrected in the port: nullish coalescing is not Python truthiness

The bridge picks a task summary from the first of `work_order`, `task`, `condition` that has
something in it. The oracle chains them with `or`, which falls through on *any* falsy value; the first
Node port used `??`, which falls through only on null and undefined. A Codex review found it and it
reproduced on all four shapes: a numeric `0` was summarized as `"0"` instead of falling through to
`task`, and an empty-string `work_order` made Node *refuse* a call the oracle dispatches.

Unreachable with today's manifests -- all four shipped declarations are
`{"type": "string", "minLength": 1}`, so validation refuses an empty string or a non-string before the
summary is computed -- but a manifest that loosened one would have found it. Ten fixture steps now
cover the falsy shapes and the truthy integer and string cases.

### Accepted divergence: a container task summary renders as canonical JSON

The oracle renders a non-string summary with `str()`, which for a container is Python repr:
`str(['a'])` is `['a']`, `str({'k': 'v'})` is `{'k': 'v'}`. Neither is reproducible from a JSON-derived
value in JavaScript, for two reasons already recorded here -- Python dicts preserve `json.loads`
insertion order while JavaScript hoists integer-like keys, and JSON gives no way to tell an `int` `1`
from a `float` `1.0`. The Node port uses canonical JSON.

The fixture deliberately covers only the exactly-reproducible shapes (falsy fallthrough, truthy integer,
truthy string) rather than encoding a golden that would be pretending to parity. A Node test states the
container behavior directly, so a future manifest that loosens a summary field's type does not change it
unnoticed.

### Corrected in the port: a length bound counted the wrong unit

`_valid_value` enforces `minLength` and `maxLength` with Python's `len()`, which counts code points.
The first Node port used `String.prototype.length`, which counts UTF-16 units. They agree for BMP text
and diverge for anything astral, so a 300-emoji argument -- 300 code points, 600 units -- was admitted
by the oracle and refused by Node against a `maxLength` of 400.

The failure a user would have seen is a tool that works on one host and not the other for input the
published schema says is fine. Caught by the golden rather than by review: the reasoning in the
first-draft comment (*"matching what `len()` counts for the BMP text these bounds describe"*) was
confidently wrong, and only a scenario carrying astral characters could show it.

A scenario now pins the bound from both sides -- six astral characters inside a bound of six, seven
outside it, and one against a minimum of two -- so the unit can never be quietly changed back.

### Implemented once in Node: the structured-state writer

`update_external` and the model's `act=update` both route through `_update_structured` in the oracle,
so an external proposal cannot get a laxer path into Structured State than a model one. The first Node
port had the update applied inline inside `consumeFastBrain`, with no external entry point at all.
Extracting it was a precondition for the bridge, and the extraction is the shared writer rather than a
second copy.

The one behavioral difference worth knowing: the oracle timestamps a rejected update with
`clock.now()` and Node uses the last applied event's `ts`. For the model path they are the same
instant. For an external update arriving between events they can differ, and Node's is the more
defensible reading -- the observation belongs to the state the reducer is in, not to wall-clock time.

### Deliberate divergence: the confirmation expiry timer is always armed

`ProjectConfirmationController._schedule_expiry` calls `asyncio.get_running_loop()` and returns
silently when there is none, so a proposal prepared outside a loop is never collected: past its
deadline `pending` reports false while `_proposal` is still set, and no expiry observer ever fires.
That is an artefact of how Python discovers its loop, not a decision -- nothing in the source says a
controller without a scheduler should behave differently -- and it leaves stale state reachable by
anything that inspects the controller directly rather than through `pending`.

The Node port always arms the timer. In production both are inside a loop, so the two agree; the
difference is only visible to a synchronous caller, which is why the committed scenarios use a step
that moves the clock without running anything and call `expire()` explicitly. Pinning the timer
would have pinned each runtime's scheduler rather than the controller.

If Python outlives the migration, `_schedule_expiry` should either arm unconditionally or the
no-loop case should clear the proposal rather than retain it.

### Pre-existing: the Codex progress end-to-end suite is load-sensitive

`tests/test_e2e_codex_progress_status.py` fails under machine load and passes idle, with the
failure count varying run to run (five to seven of fifty-four). Its `_settle` helper yields to the
event loop a fixed forty times and waits for background tasks to have finished; under load they
have not, so `final_items` is empty where the test expects one.

**This predates the migration.** Reproduced identically at `f452077` in `../codex-multi-workspace`,
so it is neither caused by the Node port nor by the split time budgets. Left alone deliberately:
fixing it means replacing a fixed yield count with a condition to wait on, which is a change to a
suite this migration is not otherwise touching. It is recorded here so the next person does not
spend the time again concluding it is their fault.

Deterministic-phase budget overruns have the same cause and the same tell: re-measure idle before
believing either.

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
  | `executors/watcher.py`, `executors/codex_projects.py` (×2), `executors/codex_app_server.py`, `realtime/project_confirmation.py` | `unicodedata.category` | Reuse the pinned table; never `\p{...}`. `isPunctuationCategory`/`hasPunctuationCategory` now cover P* alongside C*; the generator takes a list of category prefixes, so a further one is an entry in `TABLES` and nothing else |
  | `executors/search.py` | `category in {"Cc","Cf"}` | Needs a pinned Cc/Cf subset, not the whole C set |
  | `realtime/recall.py`, `executors/codex_projects.py`, `executors/codex.py`, `executors/codex_transport.py`, `executors/codex_app_server.py` (×2) | `unicodedata.normalize` NFC/NFKC | **Resolved, and neither option was needed.** See "The NFKC gap, measured" below. |
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
