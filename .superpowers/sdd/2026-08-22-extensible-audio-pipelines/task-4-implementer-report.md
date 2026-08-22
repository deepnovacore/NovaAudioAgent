# Task 4 implementer report: Generalize the cascaded owner and node ports

## Status

Implemented the provider-neutral cascaded ports, adapter, and lazy provider owner. The Volcengine ASR, TTS, and endpointing implementations now implement the generic ports. The old Volcengine owner paths and their duplicate behavior suites were deleted after the generic suites were GREEN.

The task owner explicitly resolved a brief/build conflict: because runtime TypeScript compiles all source and tests, deleting the old paths required minimal migration of direct consumers outside the original file list. I therefore migrated `runtime/src/volcengine-realtime-assembly.ts` and its surviving desktop/oracle/assembly/endpointing test imports without adding Task 5 registries or changing configuration/selector behavior.

## RED evidence

Tests were copied/renamed before production extraction, converted to fake `CascadedLlmSession` objects, and updated to assert semantic inputs. The first syntactically valid RED build was:

```text
$ npm run build --workspace @nova-audio-agent/runtime
test/realtime-cascaded-adapter.test.ts: Cannot find module '../src/realtime/cascaded/adapter.js'
test/realtime-cascaded-adapter.test.ts: Cannot find module '../src/realtime/cascaded/ports.js'
test/realtime-cascaded-provider-session.test.ts: Cannot find module '../src/realtime/cascaded/provider.js'
exit 2
```

This failed for the intended reason: the generic owner and port modules did not yet exist. One earlier compile attempt found a mechanical test-copy syntax error; that test error was corrected before accepting the RED result.

## GREEN evidence

The mandated focused matrix passed after the old files were deleted:

```text
$ npm run build --workspace @nova-audio-agent/runtime
exit 0

$ node --test \
    runtime/dist/test/realtime-cascaded-adapter.test.js \
    runtime/dist/test/realtime-cascaded-provider-session.test.js \
    runtime/dist/test/realtime-volcengine-asr-session.test.js \
    runtime/dist/test/realtime-volcengine-tts-session.test.js \
    runtime/dist/test/realtime-volcengine-endpointing-capability.test.js \
    runtime/dist/test/realtime-volcengine-livekit-endpointing.test.js \
    runtime/dist/test/realtime-volcengine-silence-endpointing.test.js
102 tests, 102 pass, 0 fail
```

Additional migrated compatibility coverage passed:

```text
$ node --test runtime/dist/test/realtime-cascaded-ark-llm.test.js \
    runtime/dist/test/realtime-volcengine-ark.test.js \
    runtime/dist/test/realtime-volcengine-adapter-oracle.test.js
30 tests, 30 pass, 0 fail
```

Static verification:

```text
$ npm run lint --workspace @nova-audio-agent/runtime
exit 0
$ npm run typecheck --workspace @nova-audio-agent/runtime
exit 0
$ git diff --check
exit 0
```

## Behavior preservation checklist

- [x] Bounded 4,096-event queue and independent 16 MiB queued-audio bound.
- [x] Copied/bounded PCM input and endpointing event ownership.
- [x] VAD start/audio/end ordering and endpoint reset behavior.
- [x] ASR open/append/finish/receive recovery paths and transcript lifecycle.
- [x] TTS chunk boundaries, prewarm, one retry before audio, replay, and no retry after audio.
- [x] Tool-only response exposure and mixed/multiple tool-call rejection policy.
- [x] Abandoned tool output suppression and matching semantic `tool_result` continuation.
- [x] Exact cancellation, mismatch rejection, and one terminal event.
- [x] Bounded close for stuck response, TTS, ASR, endpoint reset, and LLM close.
- [x] Queue-overflow terminal failure and cleanup.
- [x] Fresh-epoch fencing against late tasks and monotonic epochs across provider reconnects.
- [x] Lazy resource construction; in-flight connect ownership and cancellation.
- [x] Reverse rollback of constructed LLM/endpointing resources on partial connect failure.
- [x] Idempotent provider close and caller-owned telemetry.
- [x] Deep-copy ownership for tools, inputs, PCM, and emitted events.
- [x] Telemetry preserved except the required `volcengine.llm.*` to `cascaded.llm.*` rename.
- [x] The Python oracle passed all 17 existing Volcengine scenarios after semantic fake adaptation.

The required semantic assertions are present for both `{kind: 'user_text', text: '你好'}` and `{kind: 'tool_result', call_id: 'call-1', output: {temperature: 20}}`.

## Production files created

- `runtime/src/realtime/cascaded/ports.ts`
- `runtime/src/realtime/cascaded/adapter.ts`
- `runtime/src/realtime/cascaded/provider.ts`

## Test files created

- `runtime/test/realtime-cascaded-adapter.test.ts`
- `runtime/test/realtime-cascaded-provider-session.test.ts`

The adapter suite retains all 23 original behavior tests and adds the mandated semantic-input test. The provider-session suite retains both original formal reconnect/Guard tests and adds three lazy-owner lifecycle tests.

## Files deleted

- `runtime/src/realtime/volcengine/adapter.ts`
- `runtime/src/realtime/volcengine/provider.ts`
- `runtime/test/realtime-volcengine-adapter.test.ts`
- `runtime/test/realtime-volcengine-provider-session.test.ts`

## Other files changed

- `runtime/src/index.ts`: exports generic ports and owners.
- `runtime/src/realtime/cascaded/ark-llm.ts`: exposes construction from an injected Ark gateway so the existing assembly API can be preserved while selecting a semantic session.
- `runtime/src/realtime/volcengine/asr.ts`, `tts.ts`, `livekit-endpointing.ts`, `silence-endpointing.ts`: implement/import generic ports.
- `runtime/src/realtime/volcengine/endpointing-capability.ts`: owns the capability preparation types/factory formerly housed in the deleted provider.
- `runtime/src/volcengine-realtime-assembly.ts`: minimal compatibility composition onto `CascadedRealtimeProvider`, with a frozen Volcengine config snapshot; no Task 5 registry work.
- Surviving desktop, production/Volcengine assembly, endpointing, and Python-oracle tests: direct imports/types/classes migrated to the generic boundary.

## Self-review

- Confirmed no surviving source/test import references the deleted Volcengine adapter/provider paths.
- Confirmed the generic adapter imports no Volcengine wire transport, Ark translator, ASR/TTS implementation, or provider-specific audio helper.
- Confirmed the generic adapter sends only `CascadedLlmInput`/`CascadedLlmTool` values and has no `previousResponseId` state.
- Confirmed generic provider resource order is endpointing, ASR client, LLM session, TTS client; rollback closes constructed resources in reverse ownership order.
- Confirmed the old owner implementation is absent rather than retained as a shim or duplicate.
- Confirmed public assembly override seams still accept the existing Volcengine capability/client/Ark gateway factories.
- Mutation review: removing semantic translation, changing bounds, retry count/order, close order, epoch floor, or cleanup fencing is covered by a focused test.

## Concerns / known out-of-scope state

I also ran the migrated production/Volcengine assembly suites. Eleven tests fail before reaching the assembly/owner code because Task 1 intentionally retired `NOVA_AUDIO_AGENT_REALTIME_PROVIDER`; those suites still construct legacy selector settings pending Task 5. This is pre-existing planned migration state, not a Task 4 owner failure. The build, typecheck, lint, task-focused suites, concrete implementation suites, Ark suites, and Python oracle are GREEN.

---

## Fix round 1: continuation abandonment and early-connect ownership

### Status and controller ruling

Implemented both review findings without restoring an old-path shim or adding provider-specific state to the generic owner. The earlier controller ruling still applies: the old Volcengine owner paths remain deleted, and the minimal assembly/consumer migration remains the replacement boundary. This fix touched only the common LLM/owner implementation, Ark and Qwen adapters, and the surviving fakes/tests needed by the required interface.

### RED evidence

Production was left unchanged while regressions were added for Ark, Qwen, the generic owner, and provider rollback. The first build failed for the intended missing common lifecycle operation:

```text
$ npm test -- --test-name-pattern='abandons|adapter-connect failure|unresolved tool resets' ...
test/realtime-cascaded-ark-llm.test.ts(132,17): error TS2339:
  Property 'abandonPendingResponse' does not exist on type 'CascadedLlmSession'.
test/realtime-cascaded-qwen-llm.test.ts(165,17): error TS2339:
  Property 'abandonPendingResponse' does not exist on type 'CascadedLlmSession'.
exit 2
```

The early-connect regression was designed to fail on the pre-fix invalid-tool branch: after endpointing, ASR, LLM, TTS, and adapter construction, adapter `connect()` failed before the old ownership flag and omitted `llm.close` from reverse rollback.

### GREEN evidence

The focused new regressions passed after implementation:

```text
✔ an unresolved tool resets chaining and a late abandoned output never calls LLM
✔ an abandoned-continuation reset failure is bounded and closes the owner
✔ Ark abandons only an unfinished tool continuation before an unrelated response
✔ Qwen abandons unresolved tool state without discarding completed bounded history
✔ adapter-connect failure closes each constructed owner once in reverse order
```

Final requested verification from the repository root:

```text
$ npm run build --workspace @nova-audio-agent/runtime
exit 0
$ npm run lint --workspace @nova-audio-agent/runtime
exit 0
$ npm run typecheck --workspace @nova-audio-agent/runtime
exit 0
$ node --test <Task 2 Qwen + Task 3 Ark semantic/wire + Task 4 matrix/oracle>
146 tests, 146 pass, 0 fail
$ git diff --check
exit 0
```

This includes all 132 previously passing focused/oracle behaviors plus the Task 2 Qwen suite and five new regressions.

### Behavior preservation and fixes

- [x] Added provider-neutral `CascadedLlmSession.abandonPendingResponse()`; no provider response IDs cross the common boundary.
- [x] Generic owner calls the lifecycle operation only when replacing an unfinished tool chain with unrelated work; a matching `tool_result` continues normally.
- [x] Ark clears an unfinished tool response's private `previousResponseId`; a no-op abandonment after a completed text response preserves normal chaining.
- [x] Qwen clears only unresolved tool-call messages and retains completed, bounded history.
- [x] Late output for an abandoned call remains silently suppressed and never invokes the LLM.
- [x] Lifecycle rejection/non-cooperation is settle-time bounded, revokes the epoch, and runs the same bounded owner cleanup path before exposing stable `closed`.
- [x] Adapter owns its injected LLM immediately and closes it through one idempotent promise, including invalid tools, throwing IDs, partial construction, normal close, and provider rollback.
- [x] The provider regression observes exact reverse closable-resource order and exactly one LLM close: `llm.close`, then `endpointing.close`.
- [x] History item/code-point bounds and the host guard prefix now live in the provider-neutral LLM contract; generic cascaded code imports no Qwen module.
- [x] `CascadedRealtimeError` now exposes the generic name `CascadedRealtimeError` and generic stable message; oracle projection accepts the legacy fixture name but compares the generic observable.
- [x] Queue/audio bounds, ASR flow, TTS chunk/retry, cancellation, reconnect, monotonic epochs, fencing, telemetry, cleanup, and all 17 Python oracle scenarios remain GREEN.

### Files changed in fix round 1

Production:

- `runtime/src/realtime/cascaded/llm.ts`
- `runtime/src/realtime/cascaded/adapter.ts`
- `runtime/src/realtime/cascaded/ark-llm.ts`
- `runtime/src/realtime/cascaded/qwen-llm.ts`
- `runtime/src/realtime/qwen.ts`

Tests/fakes:

- `runtime/test/realtime-cascaded-adapter.test.ts`
- `runtime/test/realtime-cascaded-provider-session.test.ts`
- `runtime/test/realtime-cascaded-ark-llm.test.ts`
- `runtime/test/realtime-cascaded-qwen-llm.test.ts`
- `runtime/test/realtime-volcengine-adapter-oracle.test.ts`
- `runtime/test/realtime-volcengine-livekit-endpointing.test.ts`
- `runtime/test/realtime-volcengine-silence-endpointing.test.ts`

No files were deleted in this fix round.

### Self-review and concerns

- Confirmed abandonment is semantic and provider-neutral; Ark/Qwen private continuation models remain encapsulated.
- Confirmed Qwen abandonment does not clear completed history and Ark unrelated work is unchained after an abandoned tool response.
- Confirmed LLM close is single-owner/idempotent across adapter connect failure plus provider rollback, with no direct provider double-close.
- Confirmed all common-session fakes implement the new lifecycle operation and the Python oracle fake mirrors its semantics.
- Confirmed generic cascaded source has no Qwen import.
- No new concerns. The previously recorded Task 5 legacy selector-test state is unchanged and outside this fix matrix.
