# Nova Audio Agent Node Differential Fixture Contract

Status: v1 schema plus Python and Node runners active; twenty Python-exported core scenarios match.
A second family covers the realtime session at the provider-frame level: twenty-four scenarios,
matching on both legs.

## Purpose

The current JSONL trace proves event serialization but cannot drive behavioral replay: model
outputs live in runtime job tables, Floor reservations occur inside streaming tasks, and executor
completion order is external input. Migration fixtures therefore contain both scripted stimuli and
observable results. Python exports the initial goldens; Python and Node then consume the same input
and must produce the same canonical output.

Fixtures are committed test data, not recordings of production sessions. They must not contain API
keys, raw prompts, private audio, provider credentials, or unredacted external responses.

## Layout and Versioning

Store fixtures under a versioned directory such as `fixtures/runtime/v1/<scenario>/`:

```text
manifest.json
input.json
expected.json
provider-frames.jsonl       # only when the scenario exercises a provider
assets/                     # synthetic, licensed test media only
```

`schema_version` starts at `1`. Consumers reject unknown major versions. Adding an optional field
is backward compatible; changing meaning, ordering, required fields, or identity rules requires a
new major version. Goldens are updated only by an explicit reviewable command and their diff must
be visible in the change that modifies behavior.

## Manifest

`manifest.json` identifies intent and ownership:

```json
{
  "schema_version": 1,
  "id": "deadline-handoff-wins",
  "description": "A handoff at the exact deadline instant is applied before the deadline.",
  "covers": ["events.ordering", "runtime.deadline", "memory.handoff"],
  "clock": "virtual",
  "requires": [],
  "canonicalization": "exact"
}
```

`id` is stable and unique. `requires` may name synthetic capabilities such as `qwen_frames` or
`pcm_fixture`, but deterministic parity fixtures may not require a network, real device, wall
clock, user home directory, or secret.

## Input

`input.json` contains all nondeterminism needed to run the scenario:

```json
{
  "schema_version": 1,
  "initial_clock": 0,
  "id_sequences": {
    "delegate": ["d-1"]
  },
  "configuration": {
    "proactivity_preset": "balanced",
    "enabled_executors": ["fast_sim"]
  },
  "stimuli": [
    {
      "at": 0,
      "kind": "user_input",
      "text": "turn on the light"
    },
    {
      "at": 5,
      "kind": "executor_complete",
      "dispatch_index": 0,
      "outcome": "ok",
      "trust": "trusted_system",
      "content": {"state": "on"},
      "refs": []
    }
  ],
  "ports": {
    "fastbrain": [
      {
        "delay": 0,
        "output": {
          "speak": {"act": "none"},
          "action": {
            "act": "delegate",
            "delegate": {
              "executor": "fast_sim",
              "op": "set_light",
              "request": {"state": "on"},
              "origin_ref": "conversation:1"
            }
          }
        }
      }
    ],
    "surrogate": [],
    "compressor": []
  }
}
```

Each port entry is one completion owned by the next call on that port. `delay` is measured from the
call's virtual start time. `output` is intentionally not prevalidated as a valid model response:
malformed shapes must reach the runtime's contract-failure path. The runner assigns `job-N`, keeps
the output in a private result table, and places only `{slot, job_id}` or `{channel, job_id}` on the
event trace.

The final schema must support these stimulus families:

- user input and media references;
- virtual-clock advance and explicitly ordered same-instant arrivals;
- scripted FastBrain text, speak-act, action, and contract-failure deltas;
- Surrogate and Compressor completions;
- executor progress, observation, handoff, cancellation, and malformed output;
- desktop audio, activation, playback acknowledgement, memory-board request, and disconnect;
- provider text/audio/function-call frames, close, timeout, and transport failure.

Executor completions address the zero-based dispatch order, not a caller-chosen delegate ID. The
runner consumes the declared ID sequence and binds host-owned delegate ID, channel, origin,
deadline, routing class, timestamp, and event sequence fields.

`raw_progress` and `raw_observation` are test-only negative stimuli. They intentionally bypass the
normal `dispatch_index` binding so fixtures can prove that a mismatched or already-terminated
delegate cannot mutate Memory or wake a model. They are never accepted by a production transport.
Floor start/end stimuli likewise set host-owned arbitration state and do not masquerade as spine
events.

## Expected Output

`expected.json` captures public behavior and safety-relevant internal state:

```json
{
  "schema_version": 1,
  "model_views": [],
  "applied_events": [],
  "memory": {
    "channels": {"conversation": [], "fast_sim": []},
    "structured": {
      "intent": {},
      "goal": {},
      "authorization": {}
    },
    "summaries": {"conversation": null, "fast_sim": null}
  },
  "delegates": [],
  "suggestions": [],
  "floor_decisions": [],
  "outbound_desktop": [],
  "executor_effects": [],
  "diagnostics": []
}
```

The committed schema must define every array entry with Zod and JSON Schema. Comparisons are exact
after canonical serialization: UTF-8 JSON, sorted object keys, arrays kept in semantic order,
finite numbers only, and absent optional values omitted rather than converted to `null`.

Canonical numbers are value-based because JSON has one numeric kind and JavaScript cannot recover
whether a parsed integral value was written as `1` or `1.0`. Encoding uses ECMAScript's shortest
round-tripping JSON representation: `-0` becomes `0`, `1e-7` stays exponent form, and `1e20` is
written as its decimal digits. The Python exporter must use these shared conformance vectors rather
than native `json.dumps` float formatting. Model/executor request fixtures likewise may not make
behavior depend on Python's `int` versus integral-`float` source identity.

The same encoder defines the model-visible `ContextView.in_flight[].what` field. Its exact form is
`executor.op(<canonical-json-request>)`, for example
`slow_sim.set_light({"brightness":30,"room":"客厅"})`. This is an intentional migration contract,
not fixture-only normalization: Python and Node both construct that string before a model sees the
view. It replaces Python `repr`, whose float spelling and quote choices cannot be reconstructed
from JavaScript JSON values.

Do not erase legitimate differences with broad normalization. Time, IDs, ordering, generations,
delegate correlation, and message payloads are deterministic inputs and must compare exactly.
Platform paths and safe diagnostic wording may use named field-specific canonicalizers documented
in the fixture manifest. There is no catch-all "ignore diagnostics" or "ignore timestamps" mode.

## Runner Responsibilities

Both language runners must:

1. Validate every fixture file before constructing runtime objects.
2. Install the virtual clock, deterministic ID factories, and scripted ports before enqueueing the
   first stimulus.
3. Apply same-instant stimuli in declared order while preserving the runtime's deadline-last rule.
4. Drain model, executor, and playback work to a defined quiescent point after each step.
5. Fail on an unused scripted response, an unexpected port call, pending owned task, open transport,
   or unconsumed ID.
6. Serialize observations through the same canonical contract and compare the complete output.
7. Redact configuration and errors before writing any failure artifact.

Python export is a separate explicit operation from parity checking. Ordinary test runs never
rewrite goldens. Once Python is removed, the Node runner continues consuming the same fixtures and
schema; goldens change only alongside an intentional behavior decision.

The Node runner executes every scenario directory below `fixtures/runtime/v1/`, rejects unknown
schema versions and invalid timelines before constructing the runtime, and fails on unused
FastBrain, Surrogate, Compressor, executor, or ID scripts, non-quiescent slots, and retained model
jobs. `fixtures:schema` regenerates the committed Zod-derived JSON Schema; a Node test rejects drift.

The Python oracle runner validates that same schema, drives the real Python `Runtime`, and exposes
two deliberately separate commands:

```sh
uv run python scripts/runtime_fixture_oracle.py check
uv run python scripts/runtime_fixture_oracle.py export
```

`check` is read-only and runs in the normal Python suite. `export` is the only command that rewrites
`expected.json`; all twenty current goldens were produced through it and then checked again by
Node. Host stimulus groups are registered before model timers, and a zero-duration virtual-clock
barrier drains runnable work after every declared stimulus. This makes cross-source same-time order
an input contract rather than an asyncio scheduling accident.

The scenarios cover the two deadline orders, same-time dispatch/completion and observation/user
ordering, a same-time user-superseded model action, malformed FastBrain compensation, accepted and
refused Surrogate progress paths, asynchronous speak-and-delegate across another user turn, live
observation before handoff, stale/mismatched executor decorations, custom delegate IDs, and Floor
defer/preempt behavior. A synthetic credential scenario also pins deadline-evidence redaction while
asserting that applied events, Memory, and diagnostics never retain its sentinel. An explicit clock
advance scenario pins host-ingress precedence at the target instant, an invalid-origin scenario
pins bounded dispatch rejection, and a playback scenario fences a barged-in generation before a
replacement session reuses the provider response ID.
The malformed-executor scenario drives an actual scripted adapter return through each runtime's
guard and pins a payload-free `ExecutorContractError` unknown result plus its bounded follow-up.
The malformed FastBrain scenario also carries a synthetic raw-output sentinel that must be absent
from the complete runtime snapshot; file-level tests separately reject raw-prompt fields on
`model_done` before trace bytes are written.
The twentieth scenario applies a structured-state update and captures the next FastBrain
`ContextView`, so parity covers the data actually shown to models rather than only final Memory.
Every FastBrain and Surrogate call contributes a required `model_views` entry in call order.

Both languages consume `fixtures/runtime/canonical-json-vectors.json`. The vectors pin
small-exponent and large-integral formatting, negative zero, unsafe-integer binary64 rounding,
well-formed lone-surrogate and ordinary string escaping, and Unicode code-point key order. Python
uses the migration-specific ECMAScript encoder rather than native `json.dumps` formatting.

## Initial Fixture Set

The core vertical slice is not complete until it includes at least:

- async delegate completion after a later user turn;
- one FastBrain response that speaks and delegates;
- exact-deadline handoff winning over deadline fallback;
- ambient suggestion allow, defer, cooldown, and evidence re-arm;
- progress and observation accepted only for the live delegate;
- stale model completion and stale executor completion rejection;
- user barge-in without cancellation of unrelated background work;
- utterance and playback-generation fencing across clear/done acknowledgements;
- malformed model and executor output becoming bounded contract failures;
- trace and diagnostic output proving secret and raw-prompt hygiene.

Provider fixture families are added before each transport is considered ported. Real-provider and
hardware tests remain separate because their nondeterminism would make them unsuitable goldens.

## The Session Family

`fixtures/realtime/session/v1/<scenario>/` drives one layer below the core fixtures. A scenario is
a sequence of normalized provider events and host actions applied to a real `RealtimeSession`, and
the golden records, per step: what the session returned, the calls it made on the provider, the
playback effects it produced, the state a caller can observe afterwards, and any diagnostic it
printed. Its schema is generated from `runtime/src/realtime/session-fixtures.ts` into
`fixtures/realtime/session/v1/schema.json` by `npm run fixtures:schema:session`, and the Python
oracle validates every fixture against those same bytes.

Three properties of this family differ from the core one, each for a reason:

The session is driven **directly**, not through `RealtimeProviderSession`. That layer already drops
events whose epoch does not match, so a fixture routed through it could never reach the session's
own epoch guard.

One **id sequence** is shared by the session and the playback registry, as in production, and a run
that leaves an id unconsumed or asks for one past the end fails. Both mean the two runtimes
disagree about how much they allocate. In practice this guard is as load-bearing as the goldens: a
guard removed by mistake usually shows up first as a generation the scenario never declared.

`node_parity` in each manifest says whether the Node leg checks that scenario's golden. All
twenty-four now read `checked`; the marker stays in the contract because the next provider family
will land its fixtures before its reducer too, and a test fails the moment a reducer is exported
while any `pending-` marker survives. A green build that checks nothing must not read as parity.

### Validating the set

A fixture set is only worth what it can distinguish. The way to check that is to remove one guard
from the Python session, run `check`, and confirm a *named* scenario goes red -- not to read the
scenarios and judge them plausible. Thirty-eight mutations across every branch of `accept` and its
immediate helpers are currently detected, none undetected. Getting there took two rounds, and the
second round is the instructive one: an initial sweep of seventeen hand-picked guards found two
holes, and sweeping the *remaining* branches found ten more. Picking which guards to sweep is where
the judgement fails; sweep all of them.

The recurring reason a guard was indistinguishable is that another guard reached the same verdict
first, so removing either left the golden unchanged:

- `response_started` under the user floor is shadowed when a delta arrives first, because the
  delta's own floor check fences the response and the start is then refused for being *fenced*.
  Only a start with nothing before it separates the two.
- A final transcript from a fenced turn and one from an unattributable response both refuse. They
  come apart only for a response that is fenced *and* holds the provider slot, which is exactly
  what a consumed pre-start fence produces -- holding the slot is not authority.
- The two non-completed terminal paths differ only in whether the renderer is holding this
  response's generation, so a scenario needs both a failure with no generation and one with its own
  generation current.

Two mechanical gaps rather than shadowing: nothing sent a duplicate terminal, and nothing sent a
mismatched speech id, so terminal idempotence and floor-release identity were both unpinned.

Seven of the thirty-eight detections come from the id-sequence contract rather than from a golden:
a removed guard usually first shows up as a playback generation the scenario never declared. That
makes the contract as load-bearing here as the bytes.

Do this again for any guard added later. A guard no scenario can distinguish is either dead code or
a hole in the set, and the difference matters.

**Sweep the port too, not only the oracle.** Once `accept` existed in TypeScript, seventeen
mutations of it were swept the same way; sixteen were caught immediately and the seventeenth found a
real hole. Replacing caption accumulation with replacement passed every golden, because no scenario
sent two deltas for one item -- and with one delta, extending and replacing are the same thing. That
is the shape of gap to expect from a port sweep: not a missing guard, but a scenario too short to
tell two implementations apart. `node runtime/scripts/diff-session-fixture.mjs <id>` prints the first
diverging step and field.

## Review Rules

- Fixture changes require a short explanation of the intended semantic change.
- A Python/Node mismatch is a migration blocker unless the plan explicitly records and tests the
  new Node behavior as a deliberate compatibility break.
- Updating expected output to make a failing Node implementation pass without first explaining
  the Python difference is prohibited.
- Synthetic media must be repository-owned or license-compatible and small enough for normal CI.
- No fixture may reference files outside the repository or depend on the qwen-audio-agent
  submodule at runtime.
