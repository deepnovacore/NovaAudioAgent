# Task 5 implementer report: Assemble integrated and cascaded provider registries

## Status

Implemented the final integrated/cascaded assembly layer and product-level production selector. The integrated registry delegates Qwen to the existing Qwen realtime assembly. The cascaded registries compose automatic endpointing, Volcengine ASR/TTS, and the selected Qwen or Ark LLM onto the provider-neutral cascaded owner. The temporary Volcengine-shaped assembly and its old test path are deleted.

The desktop production path now carries the product-shaped assembly option type into `buildProductionRealtimeAssembly`. `DesktopRealtime` itself required no provider-specific source change: it was already a provider-neutral authenticated transport owner, and its production service coverage was migrated to integrated/cascaded selections.

## RED evidence

The exact Task 5 selector and lookup tests were written before production implementation.

```text
$ npm run build --workspace @nova-audio-agent/runtime
TS2307: Cannot find module '../src/integrated-realtime-assembly.js'
TS2307: Cannot find module '../src/cascaded-realtime-assembly.js'
TS2353: 'integrated'/'cascaded' do not exist in the retired production builder type
exit 2
```

Two selected-only regressions were also observed RED before their fixes:

```text
$ node --test runtime/dist/test/config.test.js
✖ pipeline defaults are product-shaped and cascaded defaults use Qwen Flash
  true !== false for `'realtime_provider' in settings`

$ node --test runtime/dist/test/production-realtime-assembly.test.js
✖ production selector never resolves the unselected builder property
  Error: unselected builder resolved
```

The first pinned retirement of the transitional settings property. The second proved that eagerly assigning both builders violated selected-only construction.

## GREEN evidence

Final briefed assembly/desktop verification after the last source edit:

```text
$ npm run build --workspace @nova-audio-agent/runtime && node --test \
    runtime/dist/test/integrated-realtime-assembly.test.js \
    runtime/dist/test/cascaded-realtime-assembly.test.js \
    runtime/dist/test/production-realtime-assembly.test.js \
    runtime/dist/test/desktop-realtime.test.js \
    runtime/dist/test/desktop-realtime-service.test.js && \
  npm run typecheck --workspace @nova-audio-agent/runtime && \
  npm run lint --workspace @nova-audio-agent/runtime && git diff --check
53 tests, 53 pass, 0 fail
build: exit 0; typecheck: exit 0; lint: exit 0; diff-check: exit 0
```

Related selector/config/diagnostic/protocol/export coverage:

```text
$ node --test \
    runtime/dist/test/config.test.js \
    runtime/dist/test/config-fixture.test.js \
    runtime/dist/test/diagnostics.test.js \
    runtime/dist/test/realtime-volcengine-protocol.test.js \
    runtime/dist/test/codex-root-exports.test.js
46 tests, 46 pass, 0 fail
```

The complete runtime suite was also run with the dot reporter. Every behavioral test passed; the sole failure was the intentionally deferred Task 8 parity inventory check:

```text
$ node --test --test-reporter=dot runtime/dist/test/*.test.js
1 failure: typed Node parity audit accepts only reviewed hashed occurrences
Error: Node parity audit source-file inventory changed
```

The progress ledger explicitly assigns the Task 5 production assembly inventory change to Task 8 (`Tasks 5 ↔ 8`).

## Selected-only construction and ownership evidence

- Production tests wrap `settings` in a Proxy that permits only `pipeline_mode`; both branches pass.
- A getter on the unselected builder throws if resolved; the integrated branch never resolves it.
- Cascaded tests make Ark settings/credentials inaccessible under Qwen and Dashscope credentials inaccessible under Ark; both selected assemblies build without an unselected read.
- Default registry lookup is exactly `endpointing:auto`, `asr:volcengine`, `llm:qwen`, `tts:volcengine`.
- Explicit Ark lookup is exactly `endpointing:auto`, `asr:volcengine`, `llm:ark`, `tts:volcengine`; Qwen is never constructed.
- Registry inputs contain immutable selected-provider configs plus narrow clock/ID/test seams; they do not receive the whole host options/settings object.
- Integrated Qwen socket connection count remains zero before `RealtimeAssembly.start()`.
- Cascaded endpointing capability, ASR client, LLM session, and TTS client traces remain empty before start; reconnect creates fresh epoch resources in the reviewed order.
- Closing during deferred endpointing prevents late resource construction, and partial epoch construction rolls back through the generic owner.
- Cascaded support uses Dashscope for selected Qwen and Ark for selected Ark. A configured generic model gateway takes precedence, and an injected `supportGateway` is the narrow explicit override.
- Codex resources remain host-resolved and caller-owned; telemetry remains caller-owned.

## Files created

- `runtime/src/integrated-realtime-assembly.ts`
- `runtime/src/cascaded-realtime-assembly.ts`
- `runtime/test/integrated-realtime-assembly.test.ts`
- `runtime/test/cascaded-realtime-assembly.test.ts`

## Files deleted

- `runtime/src/volcengine-realtime-assembly.ts`
- `runtime/test/volcengine-realtime-assembly.test.ts`

## Files changed

- `runtime/src/production-realtime-assembly.ts`: selects only `pipeline_mode` and resolves only the chosen builder.
- `runtime/src/qwen-realtime-assembly.ts`: accepts host-resolved selected Qwen config without rereading settings.
- `runtime/src/desktop-entry.ts`: carries the final product assembly option type into the selector.
- `runtime/src/index.ts`: exports the final registry/builders.
- `runtime/src/config.ts`: removes the transitional internal `realtime_provider` property.
- `runtime/src/diagnostics.ts`: validates only the selected product pipeline.
- `runtime/test/production-realtime-assembly.test.ts`: migrates exact branch, invalid-mode, failure, and selected-only tests.
- `runtime/test/desktop-realtime-service.test.ts`: migrates authenticated production paths to integrated Qwen and cascaded Ark.
- `runtime/test/config.test.ts`, `runtime/test/diagnostics.test.ts`: pin retired-field absence and selected pipeline diagnostics.
- `runtime/test/config-fixture.test.ts`: adapts Python-owned legacy fixture inputs only at the cross-runtime test boundary; shared fixtures remain unchanged and production has no compatibility alias.
- `runtime/test/realtime-volcengine-protocol.test.ts`: selects cascaded Ark in the legacy protocol fixture harness and preserves its legacy resolver projection locally.

## Self-review

- Confirmed there are no surviving imports or calls to `buildVolcengineRealtimeAssembly` or the deleted assembly module.
- Confirmed production source contains no read of `realtime_provider`; the old environment name remains only in the explicit retirement contract/tests and the Python-owned fixture adapter.
- Confirmed default registries are frozen, typed, injectable, and backed by the existing concrete Qwen/Ark/Volcengine adapters.
- Confirmed no Volcengine-specific owner shim was reintroduced; the cascaded builder constructs `CascadedRealtimeProvider` directly.
- Confirmed selected configs are copied and frozen before crossing registry boundaries.
- Confirmed the production selector performs inline branch lookup so accessor-backed unselected builders are untouched.
- Confirmed shared Python fixture documents have no diff.
- Confirmed no Settings Panel/storage files were changed.
- Confirmed `git diff --check`, build, typecheck, lint, focused tests, desktop runtime tests, and related legacy selector/protocol coverage after the final edits.

## Concerns / known out-of-scope state

- The Node parity audit source-file inventory must be regenerated/reviewed in Task 8, as already assigned in `progress.md`. This is the only full-runtime test failure.
- `runtime/src/desktop-realtime.ts` needed no edit because it exposes only provider-neutral bridge/server types; compile-time provider ownership is at `desktop-entry.ts` and the production assembly boundary.

---

## Fix round 1: integrated registry isolation and diagnostic parity

### Status

Resolved both review findings. An integrated provider registry now receives only the immutable selected Qwen config and provider-owned connector/ID/time callbacks. It returns the Qwen provider, while the owning integrated builder retains every host setting, core resource, model/search transport, Codex resource, callback, and composition seam. The default registry still delegates its narrow provider construction to the Qwen assembly implementation.

Added `requireSelectedCascadedRealtimeConfig`, a pure shared normalization/validation boundary used by both diagnostics and production before any provider resource construction. It resolves only the selected LLM platform and returns frozen endpointing, ASR, selected LLM, and TTS configurations.

### RED evidence

The integrated isolation regression used guarded host getters/a Settings Proxy and a registry that attempted to inspect any exposed host options. Before the fix:

```text
$ npm run build --workspace @nova-audio-agent/runtime && \
  node --test runtime/dist/test/integrated-realtime-assembly.test.js
2 pass, 1 fail
✖ integrated registry receives only selected provider inputs and cannot inspect host composition
AssertionError: true !== false for `'options' in input`
exit 1
```

The diagnostics parity regression compared representative invalid selected cascaded settings against real production construction. Before the shared boundary:

```text
$ npm run build --workspace @nova-audio-agent/runtime && \
  node --test --test-name-pattern="cascaded diagnostics" \
    runtime/dist/test/diagnostics.test.js
1 pass, 1 fail
✖ cascaded diagnostics reject every representative configuration production rejects
secure ASR endpoint: actual `volcengine_configuration_valid`, expected invalid
exit 1
```

### GREEN evidence

The first focused cycle passed together with all direct Qwen assembly behavior:

```text
$ npm run build --workspace @nova-audio-agent/runtime && node --test \
    runtime/dist/test/integrated-realtime-assembly.test.js \
    runtime/dist/test/qwen-realtime-assembly.test.js
13 tests, 13 pass, 0 fail
```

The second focused cycle passed together with the cascaded assembly suite:

```text
$ npm run build --workspace @nova-audio-agent/runtime && \
  node --test --test-name-pattern="cascaded diagnostics" \
    runtime/dist/test/diagnostics.test.js && \
  node --test runtime/dist/test/cascaded-realtime-assembly.test.js
12 tests, 12 pass, 0 fail
```

Final expanded Task 5 matrix after the last production edit:

```text
$ npm run build --workspace @nova-audio-agent/runtime && node --test \
    runtime/dist/test/integrated-realtime-assembly.test.js \
    runtime/dist/test/cascaded-realtime-assembly.test.js \
    runtime/dist/test/production-realtime-assembly.test.js \
    runtime/dist/test/qwen-realtime-assembly.test.js \
    runtime/dist/test/desktop-realtime.test.js \
    runtime/dist/test/desktop-realtime-service.test.js \
    runtime/dist/test/config.test.js \
    runtime/dist/test/config-fixture.test.js \
    runtime/dist/test/diagnostics.test.js \
    runtime/dist/test/realtime-volcengine-protocol.test.js \
    runtime/dist/test/codex-root-exports.test.js
112 tests, 112 pass, 0 fail

$ npm run typecheck --workspace @nova-audio-agent/runtime
exit 0
$ npm run lint --workspace @nova-audio-agent/runtime
exit 0
$ git diff --check
exit 0
```

The complete dot-reporter suite again had exactly one failure, the unchanged Task 8-owned parity inventory check; every behavioral test passed.

### Files changed in fix round 1

- Created `runtime/src/cascaded-realtime-config.ts`.
- Changed `runtime/src/cascaded-realtime-assembly.ts`, `runtime/src/diagnostics.ts`, and `runtime/src/index.ts` to consume/export the shared selected normalization.
- Changed `runtime/src/integrated-realtime-assembly.ts` and `runtime/src/qwen-realtime-assembly.ts` to separate narrow provider creation from host-owned composition.
- Changed `runtime/test/integrated-realtime-assembly.test.ts` and `runtime/test/diagnostics.test.ts` with the reviewed RED regressions.

### Review checklist

- [x] Registry input has no `options`, `settings`, search/model transport, Codex resource, callbacks, or unrelated provider credential access.
- [x] The selected config is copied/frozen before registry invocation.
- [x] Provider construction receives only config, optional connector, a provider-namespaced ID callback, and time callback.
- [x] Default Qwen registry delegates to the narrow overload of `buildQwenRealtimeAssembly`; host composition then invokes the full assembly overload outside the registry.
- [x] Direct Qwen callers retain their reviewed API/behavior and all 10 direct assembly tests pass.
- [x] Cascaded diagnostics and production share endpoint security, required-resource/text, VAD relationship, ASR chunk, TTS endpoint, and 24 kHz validation.
- [x] Diagnostic regressions cover malformed ASR security scheme, zero VAD threshold, zero ASR chunk, and non-24 kHz TTS.
- [x] Qwen diagnostics cannot read Ark credential/base URL; Ark diagnostics cannot read Dashscope credentials.
- [x] Diagnostic output contains only fixed IDs/codes and none of the sentinel URLs/credentials.
- [x] Registry lookup order, explicit Ark isolation, support gateway selection, lazy resources, and production selector getter safety remain GREEN.

### Concerns

No new implementation concern. The sole full-suite failure remains the explicitly deferred Task 8 source-file parity inventory refresh; this fix adds one more reviewed source file to that same pending inventory update.
