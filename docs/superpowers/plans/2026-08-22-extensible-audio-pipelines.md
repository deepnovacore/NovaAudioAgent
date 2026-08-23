# Extensible Audio Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add integrated and cascaded pipeline modes, make cascaded ASR/LLM/TTS nodes provider-selectable, ship Qwen `qwen-flash` and Ark LLM adapters, and expose the complete configuration safely in the Electron Settings Panel.

**Architecture:** Keep `RealtimeProvider` as the outer runtime boundary. Select an integrated provider as one unit, or assemble a provider-neutral cascaded owner from typed endpointing, ASR, LLM, and TTS factories. Store provider choices publicly and platform credentials once in Electron Main; inject only the selected configuration into the Node runtime.

**Tech Stack:** Node.js 22.12+, TypeScript 5.9, Zod 4, Node test runner, Electron ESM/CJS renderer-main bridge, Fetch/SSE, WebSocket, ESLint.

**Spec:** `docs/superpowers/specs/2026-08-22-extensible-audio-pipelines-design.md`

## Global Constraints

- Node and TypeScript under `runtime/` are the production runtime; do not extend the Python reference runtime.
- Do not preserve `NOVA_AUDIO_AGENT_REALTIME_PROVIDER`; reject any nonblank value as retired configuration.
- Default integrated pipeline: Qwen Audio Realtime.
- Default cascaded pipeline: `auto` endpointing, Volcengine ASR, Qwen `qwen-flash`, Volcengine TTS.
- Cascaded LLM alternatives in this release: `qwen` and `ark`; do not add automatic failover.
- Store one credential per platform. Do not add per-node duplicate API-key settings.
- Validate and construct only providers selected by the active pipeline.
- Never expose credentials, prompts, transcripts, provider response bodies, URLs containing queries, or tool arguments in errors or diagnostics.
- Keep realtime session, authorization, playback, Codex ownership, Electron CSP, IPC ownership, and secret forward-only boundaries unchanged.
- Use `apply_patch` for file edits and preserve unrelated working-tree changes.

## File Structure

### New runtime units

- `runtime/src/realtime/cascaded/llm.ts`: provider-neutral semantic LLM input, event, session, and factory contracts plus history bounds.
- `runtime/src/realtime/cascaded/ports.ts`: provider-neutral endpointing, ASR, and TTS port/factory contracts.
- `runtime/src/realtime/cascaded/qwen-llm.ts`: DashScope Chat Completions implementation and bounded client-owned history.
- `runtime/src/realtime/cascaded/ark-llm.ts`: adapter from semantic cascaded inputs to the existing Ark Responses transport.
- `runtime/src/realtime/cascaded/adapter.ts`: provider-neutral cascaded `RealtimeProvider` orchestration currently embedded in the Volcengine adapter.
- `runtime/src/realtime/cascaded/provider.ts`: lazy per-epoch node construction, selected factory ownership, and rollback.
- `runtime/src/integrated-realtime-assembly.ts`: typed integrated-provider registry and Qwen assembly selection.
- `runtime/src/cascaded-realtime-assembly.ts`: typed node registries and provider-neutral cascaded production assembly.

### Retained provider units

- `runtime/src/realtime/volcengine/asr.ts`, `tts.ts`, endpointing files, protocol, audio, and WebSocket remain Volcengine implementations of provider-neutral ports.
- `runtime/src/realtime/volcengine/ark.ts` remains the bounded Ark Responses wire transport; Ark semantic mapping moves to `cascaded/ark-llm.ts`.
- `runtime/src/qwen-realtime-assembly.ts` remains the concrete integrated Qwen builder.

### Removed/replaced units

- Replace `runtime/src/realtime/volcengine/adapter.ts` with `realtime/cascaded/adapter.ts`.
- Replace `runtime/src/realtime/volcengine/provider.ts` with `realtime/cascaded/provider.ts`.
- Replace `runtime/src/volcengine-realtime-assembly.ts` with `runtime/src/cascaded-realtime-assembly.ts`.
- Rename the corresponding tests to `realtime-cascaded-*` and `cascaded-realtime-assembly.test.ts` as their imports move.

---

### Task 1: Define the new configuration and environment contract

**Files:**
- Modify: `runtime/test/config.test.ts`
- Modify: `runtime/test/documentation-contract.test.ts`
- Modify: `runtime/src/config.ts`
- Modify: `runtime/src/environment-contract.ts`
- Modify: `runtime/test/diagnostics.test.ts`
- Modify: `.env.example`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`

**Interfaces:**
- Produces: `PipelineMode`, `IntegratedProviderName`, `CascadedEndpointingProviderName`, `CascadedAsrProviderName`, `CascadedLlmProviderName`, and `CascadedTtsProviderName` string unions.
- Produces: `requireIntegratedRealtime(settings): QwenRealtimeConfig`.
- Produces: `resolveCascadedSelection(settings): CascadedSelection` with provider-sensitive model defaults and no secrets.
- Produces: `requireCascadedCredentials(settings, selection): CascadedCredentials` containing only selected credentials.
- Consumes: existing secure endpoint and Python-compatible whitespace helpers in `config.ts`.

- [ ] **Step 1: Write failing configuration tests**

Add focused tests that express the new API:

```ts
test('pipeline defaults are product-shaped and cascaded defaults use Qwen Flash', () => {
  const settings = loadSettings({})
  assert.equal(settings.pipeline_mode, 'integrated')
  assert.deepEqual(resolveCascadedSelection(settings), {
    endpointingProvider: 'auto',
    asrProvider: 'volcengine',
    llmProvider: 'qwen',
    llmModel: 'qwen-flash',
    ttsProvider: 'volcengine',
  })
})

test('Ark receives its provider default only when no model override exists', () => {
  const implicit = loadSettings({NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark'})
  const explicit = loadSettings({
    NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: 'ark',
    NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL: 'ark-custom',
  })
  assert.equal(resolveCascadedSelection(implicit).llmModel, 'doubao-seed-2-0-pro-260215')
  assert.equal(resolveCascadedSelection(explicit).llmModel, 'ark-custom')
})

test('retired realtime provider configuration fails by field name only', () => {
  assert.throws(
    () => loadSettings({NOVA_AUDIO_AGENT_REALTIME_PROVIDER: 'secret-old-value'}),
    error => error instanceof ConfigurationError
      && error.code === 'retired_configuration'
      && error.fields?.join(',') === 'NOVA_AUDIO_AGENT_REALTIME_PROVIDER'
      && !error.message.includes('secret-old-value'),
  )
})
```

Also add Proxy-based tests proving an integrated load never reads Ark/Doubao credential slots and a cascaded Qwen resolution never reads `ARK_API_KEY`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/config.test.js runtime/dist/test/diagnostics.test.js
```

Expected: FAIL because the new settings fields and resolver functions do not exist and the old selector is still accepted.

- [ ] **Step 3: Implement the schemas and selected-only resolvers**

Add the exact selection shape:

```ts
export interface CascadedSelection {
  readonly endpointingProvider: 'auto'
  readonly asrProvider: 'volcengine'
  readonly llmProvider: 'qwen' | 'ark'
  readonly llmModel: string
  readonly ttsProvider: 'volcengine'
}

export interface CascadedCredentials {
  readonly llmApiKey: string
  readonly asrApiKey: string
  readonly ttsApiKey: string
}
```

Parse `NOVA_AUDIO_AGENT_PIPELINE_MODE` first. Read integrated settings only for integrated mode and cascaded selectors/settings only for cascaded mode; conditionally populate the existing strict schema so malformed unselected provider values are never accessed and schema defaults fill their inert fields. Move retired-field detection for `NOVA_AUDIO_AGENT_REALTIME_PROVIDER` into `environment-contract.ts`. Resolve the LLM model after provider selection so an absent environment value produces the provider default while an explicit empty string is rejected.

Update the public environment rows with the seven new selectors and mark the old selector private/retired. Keep provider-specific endpoint/resource variables classified under their provider owner.

Run the environment-contract writer once without `--check` so `.env.example` and both getting-started generated blocks match the new rows before committing this task.

- [ ] **Step 4: Run configuration tests and verify GREEN**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/config.test.js runtime/dist/test/diagnostics.test.js runtime/dist/test/documentation-contract.test.js
```

Expected: all listed tests PASS.

- [ ] **Step 5: Commit the configuration contract**

```bash
git add runtime/src/config.ts runtime/src/environment-contract.ts runtime/test/config.test.ts runtime/test/diagnostics.test.ts runtime/test/documentation-contract.test.ts .env.example docs/getting-started.md docs/getting-started.zh-CN.md
git commit -m "feat(config): add product-shaped audio pipeline selection"
```

---

### Task 2: Add the semantic cascaded LLM contract and Qwen adapter

**Files:**
- Create: `runtime/src/realtime/cascaded/llm.ts`
- Create: `runtime/src/realtime/cascaded/qwen-llm.ts`
- Create: `runtime/test/realtime-cascaded-qwen-llm.test.ts`
- Modify: `runtime/src/index.ts`

**Interfaces:**
- Produces: `CascadedLlmInput`, `CascadedLlmTool`, `CascadedLlmEvent`, `CascadedLlmSession`, and `CascadedLlmFactory`.
- Produces: `createQwenCascadedLlmFactory(options): CascadedLlmFactory`.
- Consumes: `JsonValue`, `JsonObject`, `Clock`, Fetch, and the existing safe SSE parsing patterns in `model-gateway.ts`.

- [ ] **Step 1: Write failing Qwen request and streaming tests**

Pin a semantic request and common events:

```ts
const session = createQwenCascadedLlmFactory({
  baseUrl: 'https://dashscope.example/compatible-mode/v1',
  apiKey: 'dash-secret',
  model: 'qwen-flash',
  instructions: 'system instructions',
  fetchImpl,
  idFactory: () => 'host-response-1',
}).open()

const events = await collect(session.stream({
  inputs: [{kind: 'user_text', text: '你好'}],
  tools: [],
  signal: new AbortController().signal,
}))

assert.deepEqual(events, [
  {kind: 'response_started', response_id: 'provider-response-1'},
  {kind: 'text_delta', text: '你'},
  {kind: 'text_delta', text: '好'},
  {kind: 'response_completed', response_id: 'provider-response-1'},
])
```

Assert the request targets `/chat/completions`, uses Bearer auth, sets `stream: true`, includes `stream_options.include_usage`, sends the system/user messages, and never serializes the API key into the body.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-cascaded-qwen-llm.test.js
```

Expected: FAIL because the contract and Qwen adapter modules do not exist.

- [ ] **Step 3: Implement the common contract and minimal text streaming**

Define the semantic types:

```ts
export type CascadedLlmInput =
  | {readonly kind: 'user_text'; readonly text: string}
  | {readonly kind: 'host_context'; readonly content: string}
  | {readonly kind: 'packed_history'; readonly content: string}
  | {readonly kind: 'tool_result'; readonly call_id: string; readonly output: JsonValue}

export interface CascadedLlmTool {
  readonly name: string
  readonly description?: string
  readonly parameters: JsonObject
}

export type CascadedLlmEvent =
  | {readonly kind: 'response_started'; readonly response_id: string}
  | {readonly kind: 'text_delta'; readonly text: string}
  | {readonly kind: 'tool_call'; readonly item_id: string; readonly call_id: string; readonly name: string; readonly arguments: JsonObject}
  | {readonly kind: 'response_completed'; readonly response_id: string}
  | {readonly kind: 'response_failed'; readonly response_id: string; readonly code: string}

export interface CascadedLlmSession {
  stream(input: {readonly inputs: readonly CascadedLlmInput[]; readonly tools: readonly CascadedLlmTool[]; readonly signal: AbortSignal}): AsyncIterable<CascadedLlmEvent>
  close(): Promise<void>
}

export interface CascadedLlmFactory {
  open(): CascadedLlmSession
}
```

Implement bounded SSE parsing, timeout/abort handling, credential-safe failures, and text deltas. Do not import the generic `ModelGateway`: cascaded history and tool continuation require a distinct session owner.

- [ ] **Step 4: Add failing tool and history tests**

Add tests for fragmented tool name/arguments, assistant tool-call retention, matching `tool_result`, mixed text/tool rejection, malformed JSON arguments, mismatched call IDs, close/abort, and limits:

```ts
assert.deepEqual(toolEvents.at(-2), {
  kind: 'tool_call', item_id: 'call-1', call_id: 'call-1',
  name: 'search__query', arguments: {q: 'weather'},
})
assert.ok(lastRequest.messages.some(message =>
  message.role === 'tool' && message.tool_call_id === 'call-1'))
```

Generate 65 completed history messages and more than 131,072 code points, then assert only oldest completed interaction units are removed and an unresolved tool call/result pair is never split.

- [ ] **Step 5: Implement tools and bounded interaction history**

Export `MAX_CASCADED_LLM_HISTORY_ITEMS = 64` and `MAX_CASCADED_LLM_HISTORY_CODEPOINTS = 131_072`. Store history as completed units, append a unit only after a terminal event, and keep an unresolved tool chain separate until its matching result arrives. Assemble all tool-call fragments by index and emit exactly one semantic `tool_call`.

- [ ] **Step 6: Verify the Qwen adapter GREEN**

Run:

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-cascaded-qwen-llm.test.js
npm run typecheck --workspace @nova-audio-agent/runtime
```

Expected: all Qwen adapter tests PASS and type checking exits 0.

- [ ] **Step 7: Commit the Qwen cascaded LLM adapter**

```bash
git add runtime/src/realtime/cascaded/llm.ts runtime/src/realtime/cascaded/qwen-llm.ts runtime/test/realtime-cascaded-qwen-llm.test.ts runtime/src/index.ts
git commit -m "feat(realtime): add Qwen cascaded LLM session"
```

---

### Task 3: Adapt Ark Responses to the common LLM contract

**Files:**
- Create: `runtime/src/realtime/cascaded/ark-llm.ts`
- Create: `runtime/test/realtime-cascaded-ark-llm.test.ts`
- Modify: `runtime/src/realtime/volcengine/ark.ts`
- Modify: `runtime/test/realtime-volcengine-ark.test.ts`
- Modify: `runtime/src/index.ts`

**Interfaces:**
- Produces: `createArkCascadedLlmFactory(options): CascadedLlmFactory`.
- Consumes: common LLM types from Task 2 and `createFetchArkResponsesGateway` from the bounded wire transport.

- [ ] **Step 1: Write failing semantic-mapping tests**

Feed user text, host context, a tool result, and a common tool declaration into an Ark session. Assert that the captured Ark request receives Responses items and that Ark events return as common events. Assert `previousResponseId` is reused on the second response but is absent from the public common input.

- [ ] **Step 2: Run the Ark adapter test and verify RED**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-cascaded-ark-llm.test.js
```

Expected: FAIL because `ark-llm.ts` does not exist.

- [ ] **Step 3: Implement the Ark semantic adapter**

Map common inputs as follows:

```ts
user_text      -> {role: 'user', content: text}
host_context   -> {role: 'user', content}
packed_history -> {role: 'user', content}
tool_result    -> {type: 'function_call_output', call_id, output: JSON.stringify(output)}
```

Move `responsesToolSchema` usage behind this adapter. Keep the wire transport's byte/event/time limits and redaction behavior unchanged. The adapter owns `previousResponseId` and clears it on protocol failure or close.

- [ ] **Step 4: Run common and wire tests GREEN**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-cascaded-ark-llm.test.js runtime/dist/test/realtime-volcengine-ark.test.js
```

Expected: both suites PASS.

- [ ] **Step 5: Commit the Ark adapter**

```bash
git add runtime/src/realtime/cascaded/ark-llm.ts runtime/test/realtime-cascaded-ark-llm.test.ts runtime/src/realtime/volcengine/ark.ts runtime/test/realtime-volcengine-ark.test.ts runtime/src/index.ts
git commit -m "refactor(realtime): place Ark behind cascaded LLM contract"
```

---

### Task 4: Generalize the cascaded owner and node ports

**Files:**
- Create: `runtime/src/realtime/cascaded/ports.ts`
- Create: `runtime/src/realtime/cascaded/adapter.ts`
- Create: `runtime/src/realtime/cascaded/provider.ts`
- Create: `runtime/test/realtime-cascaded-adapter.test.ts`
- Create: `runtime/test/realtime-cascaded-provider-session.test.ts`
- Modify: `runtime/src/realtime/volcengine/asr.ts`
- Modify: `runtime/src/realtime/volcengine/tts.ts`
- Modify: `runtime/src/realtime/volcengine/livekit-endpointing.ts`
- Modify: `runtime/src/realtime/volcengine/silence-endpointing.ts`
- Modify: `runtime/src/realtime/volcengine/endpointing-capability.ts`
- Delete: `runtime/src/realtime/volcengine/adapter.ts`
- Delete: `runtime/src/realtime/volcengine/provider.ts`
- Delete: `runtime/test/realtime-volcengine-adapter.test.ts`
- Delete: `runtime/test/realtime-volcengine-provider-session.test.ts`
- Modify: `runtime/src/index.ts`

**Interfaces:**
- Produces: generic `EndpointingPort`, `AsrClient`, `AsrSession`, `TtsClient`, and `TtsSession` types.
- Produces: `CascadedRealtimeAdapter` implementing `RealtimeProvider`.
- Produces: `CascadedRealtimeProvider` accepting four selected factories and immutable per-node configs.
- Consumes: `CascadedLlmFactory` from Tasks 2–3 and existing `RealtimeProviderEvent` types.

- [ ] **Step 1: Copy and rename the existing behavior tests before production edits**

Create the two new cascaded test files from the existing Volcengine suites, change imports and class names to the desired generic APIs, and replace fake `ArkResponsesGateway` objects with fake `CascadedLlmSession` objects. Preserve every assertion for queue bounds, ASR flow, TTS retry, tool continuation, cancellation, reconnect, epoch fencing, and cleanup.

Add an assertion that the adapter consumes semantic LLM inputs:

```ts
assert.deepEqual(llm.calls[0]?.inputs.at(-1), {kind: 'user_text', text: '你好'})
assert.deepEqual(llm.calls[1]?.inputs.at(-1), {
  kind: 'tool_result', call_id: 'call-1', output: {temperature: 20},
})
```

- [ ] **Step 2: Run new suites and verify RED**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/realtime-cascaded-adapter.test.js runtime/dist/test/realtime-cascaded-provider-session.test.js
```

Expected: FAIL because generic ports and owners do not exist.

- [ ] **Step 3: Extract ports and port the cascaded adapter**

Move only the provider-neutral orchestration. Use this constructor boundary:

```ts
export type EndpointingFactory = (input: {
  readonly signal: AbortSignal
  readonly telemetry?: RealtimeTelemetry
}) => Promise<EndpointingPort>

export interface AsrFactory {
  openClient(): AsrClient
}

export interface TtsFactory {
  openClient(): TtsClient
}

export interface CascadedRealtimeAdapterOptions {
  readonly endpointing: EndpointingPort
  readonly asr: AsrClient
  readonly llm: CascadedLlmSession
  readonly tts: TtsClient
  readonly telemetry?: RealtimeTelemetry
  readonly idFactory?: () => string
  readonly settleTimeoutMs?: number
  readonly initialEpoch?: number
}
```

Replace `owner.ark.stream(...)` with `owner.llm.stream(...)`, translate host items into semantic inputs in one focused helper, and rename `volcengine.llm.*` telemetry to `cascaded.llm.*`. Preserve the current event limits, audio limits, TTS chunking, retry, and terminal sequencing.

- [ ] **Step 4: Port the lazy provider owner**

Use capability-specific factories:

```ts
export interface CascadedRealtimeProviderOptions {
  readonly endpointingFactory: EndpointingFactory
  readonly asrFactory: AsrFactory
  readonly llmFactory: CascadedLlmFactory
  readonly ttsFactory: TtsFactory
  readonly telemetry?: RealtimeTelemetry
  readonly idFactory: () => string
}
```

Construct resources only during `connect()`. On failure, close only constructed resources in reverse order. Keep the epoch monotonic across reconnects and make `close()` idempotent.

- [ ] **Step 5: Update Volcengine implementations to generic ports and remove old owners**

Change imports in ASR, TTS, and endpointing implementations to `../cascaded/ports.js`. Delete the old adapter/provider and old test files only after their generic replacements compile and contain the original behavior assertions.

- [ ] **Step 6: Run cascaded and Volcengine implementation suites GREEN**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test \
  runtime/dist/test/realtime-cascaded-adapter.test.js \
  runtime/dist/test/realtime-cascaded-provider-session.test.js \
  runtime/dist/test/realtime-volcengine-asr-session.test.js \
  runtime/dist/test/realtime-volcengine-tts-session.test.js \
  runtime/dist/test/realtime-volcengine-endpointing-capability.test.js \
  runtime/dist/test/realtime-volcengine-livekit-endpointing.test.js \
  runtime/dist/test/realtime-volcengine-silence-endpointing.test.js
```

Expected: all listed suites PASS.

- [ ] **Step 7: Commit the provider-neutral cascaded owner**

```bash
git add runtime/src/realtime/cascaded/ports.ts runtime/src/realtime/cascaded/adapter.ts runtime/src/realtime/cascaded/provider.ts runtime/src/realtime/volcengine/adapter.ts runtime/src/realtime/volcengine/provider.ts runtime/src/realtime/volcengine/asr.ts runtime/src/realtime/volcengine/tts.ts runtime/src/realtime/volcengine/livekit-endpointing.ts runtime/src/realtime/volcengine/silence-endpointing.ts runtime/src/realtime/volcengine/endpointing-capability.ts runtime/test/realtime-cascaded-adapter.test.ts runtime/test/realtime-cascaded-provider-session.test.ts runtime/test/realtime-volcengine-adapter.test.ts runtime/test/realtime-volcengine-provider-session.test.ts runtime/src/index.ts
git commit -m "refactor(realtime): generalize cascaded pipeline ownership"
```

---

### Task 5: Assemble integrated and cascaded provider registries

**Files:**
- Create: `runtime/src/integrated-realtime-assembly.ts`
- Create: `runtime/src/cascaded-realtime-assembly.ts`
- Create: `runtime/test/integrated-realtime-assembly.test.ts`
- Create: `runtime/test/cascaded-realtime-assembly.test.ts`
- Modify: `runtime/src/production-realtime-assembly.ts`
- Modify: `runtime/test/production-realtime-assembly.test.ts`
- Modify: `runtime/src/qwen-realtime-assembly.ts`
- Modify: `runtime/src/desktop-entry.ts`
- Modify: `runtime/src/desktop-realtime.ts`
- Modify: `runtime/src/index.ts`
- Delete: `runtime/src/volcengine-realtime-assembly.ts`
- Delete: `runtime/test/volcengine-realtime-assembly.test.ts`

**Interfaces:**
- Produces: `IntegratedProviderRegistry` with `qwen`.
- Produces: `CascadedProviderRegistries` with `auto`, Volcengine ASR/TTS, and Qwen/Ark LLM factories.
- Produces: `buildIntegratedRealtimeAssembly` and `buildCascadedRealtimeAssembly`.
- Consumes: config resolvers from Task 1 and node factories from Tasks 2–4.

- [ ] **Step 1: Write failing selector and construction tests**

Pin exact branch selection:

```ts
assert.equal(buildProductionRealtimeAssembly(options(integrated), {
  integrated: () => integratedResult,
  cascaded: () => { throw new Error('unselected') },
}), integratedResult)

assert.equal(buildProductionRealtimeAssembly(options(cascaded), {
  integrated: () => { throw new Error('unselected') },
  cascaded: () => cascadedResult,
}), cascadedResult)
```

In the cascaded assembly test, inject recording registries and assert the default lookup sequence is `endpointing:auto`, `asr:volcengine`, `llm:qwen`, `tts:volcengine`. Add the explicit Ark case and assert Qwen is not constructed.

- [ ] **Step 2: Run assembly tests and verify RED**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/integrated-realtime-assembly.test.js runtime/dist/test/cascaded-realtime-assembly.test.js runtime/dist/test/production-realtime-assembly.test.js
```

Expected: FAIL because the new assemblies and registry interfaces do not exist.

- [ ] **Step 3: Implement integrated and cascaded builders**

The production selector must be only:

```ts
if (options.settings.pipeline_mode === 'integrated') return integrated(options)
if (options.settings.pipeline_mode === 'cascaded') return cascaded(options)
throw new ConfigurationError('NOVA_AUDIO_AGENT_PIPELINE_MODE 无效')
```

The cascaded builder resolves each selected factory, creates provider-specific immutable config, builds one support gateway from the selected LLM platform unless the generic support override is present, and passes the provider-neutral owner into `buildRealtimeAssembly`.

The integrated registry's `qwen` entry delegates to `buildQwenRealtimeAssembly`; it does not duplicate Qwen transport code.

- [ ] **Step 4: Update desktop production ownership and exports**

Update compile-time option types in desktop entry/realtime files and root exports. Remove old Volcengine assembly imports. Keep resource acquisition deferred to `RealtimeAssembly.start()`.

- [ ] **Step 5: Run assembly and desktop-runtime tests GREEN**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test \
  runtime/dist/test/integrated-realtime-assembly.test.js \
  runtime/dist/test/cascaded-realtime-assembly.test.js \
  runtime/dist/test/production-realtime-assembly.test.js \
  runtime/dist/test/desktop-realtime.test.js \
  runtime/dist/test/desktop-realtime-service.test.js
```

Expected: all listed suites PASS.

- [ ] **Step 6: Commit production assembly selection**

```bash
git add runtime/src/integrated-realtime-assembly.ts runtime/src/cascaded-realtime-assembly.ts runtime/src/production-realtime-assembly.ts runtime/src/qwen-realtime-assembly.ts runtime/src/desktop-entry.ts runtime/src/desktop-realtime.ts runtime/src/volcengine-realtime-assembly.ts runtime/src/index.ts runtime/test/integrated-realtime-assembly.test.ts runtime/test/cascaded-realtime-assembly.test.ts runtime/test/production-realtime-assembly.test.ts runtime/test/volcengine-realtime-assembly.test.ts
git commit -m "feat(realtime): assemble integrated and cascaded providers"
```

---

### Task 6: Upgrade secure Settings storage and backend environment injection

**Files:**
- Modify: `desktop/ambient-orb/test/settings-store.test.mjs`
- Modify: `desktop/ambient-orb/test/backend.test.mjs`
- Modify: `desktop/ambient-orb/src/main/settings-store.mjs`
- Modify: `desktop/ambient-orb/src/main/backend.mjs`
- Modify: `desktop/ambient-orb/src/main/main.mjs`

**Interfaces:**
- Produces: settings schema version 2 with pipeline/provider/model/voice fields.
- Produces: `cascadedLlmModels: {qwen: string, ark: string}`.
- Produces: secret presence and storage for `arkApiKey`, `doubaoBigmodelApiKey`, and `doubaoAsrApiKey`.
- Consumes: existing `safeStorage` codec, queued writer, and `backendLaunchSpec`.

- [ ] **Step 1: Write failing version-2 store tests**

Pin the defaults:

```js
assert.deepEqual(DEFAULT_SETTINGS, {
  version: 2,
  palette: 'ember',
  proactivity: 'balanced',
  codexHeartbeatSeconds: 30,
  pipelineMode: 'integrated',
  integratedProvider: 'qwen',
  integratedModel: 'qwen-audio-3.0-realtime-plus',
  integratedVoice: 'longanqian',
  cascadedEndpointingProvider: 'auto',
  cascadedAsrProvider: 'volcengine',
  cascadedLlmProvider: 'qwen',
  cascadedLlmModels: {qwen: 'qwen-flash', ark: 'doubao-seed-2-0-pro-260215'},
  cascadedTtsProvider: 'volcengine',
  cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
  secrets: {},
})
```

Add independent invalid-field fallback tests, strict model-map tests, and presence/sealing/clear tests for all seven secret keys.

- [ ] **Step 2: Run store tests and verify RED**

```bash
node --test desktop/ambient-orb/test/settings-store.test.mjs
```

Expected: FAIL because version 1 and the old four-key schema are still active.

- [ ] **Step 3: Implement schema version 2 without key leakage**

Set `SETTINGS_VERSION = 2`; add enum and bounded string validators; rebuild public settings with all non-secret fields; expand `SECRET_KEYS`. Remove the shared `voice` field. Keep unknown-field dropping, independent fallback, per-field secret rejection, opportunistic re-sealing, atomic writes, and presence-only renderer views.

- [ ] **Step 4: Write failing launch mapping tests**

Assert integrated mappings and cascaded mappings separately. The cascaded Qwen case must include:

```js
assert.equal(spec.env.NOVA_AUDIO_AGENT_PIPELINE_MODE, 'cascaded')
assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER, 'qwen')
assert.equal(spec.env.NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL, 'qwen-flash')
assert.equal(spec.env.NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE, 'zh_female_vv_uranus_bigtts')
assert.equal(spec.env.DASHSCOPE_API_KEY, 'dash-key')
assert.equal(spec.env.DOUBAO_BIGMODEL_API_KEY, 'doubao-key')
assert.equal('ARK_API_KEY' in spec.env, false)
```

Add an Ark selection case that injects `ARK_API_KEY` and the remembered Ark model without mutating the remembered Qwen model.

- [ ] **Step 5: Implement backend mappings**

Extend `SETTINGS_DEFAULTS`, public-setting environment mapping, and `SECRET_ENV_MAP`:

```js
arkApiKey: 'ARK_API_KEY',
doubaoBigmodelApiKey: 'DOUBAO_BIGMODEL_API_KEY',
doubaoAsrApiKey: 'DOUBAO_ASR_API_KEY',
```

Inject the active remembered LLM model. Continue trimming secret overrides and omitting absent/unsafe values so parent environment values survive.

- [ ] **Step 6: Run desktop Main tests GREEN**

```bash
node --test desktop/ambient-orb/test/settings-store.test.mjs desktop/ambient-orb/test/backend.test.mjs desktop/ambient-orb/test/preload.test.mjs
```

Expected: all listed suites PASS.

- [ ] **Step 7: Commit secure settings and launch mapping**

```bash
git add desktop/ambient-orb/src/main desktop/ambient-orb/test/settings-store.test.mjs desktop/ambient-orb/test/backend.test.mjs desktop/ambient-orb/test/preload.test.mjs
git commit -m "feat(settings): store audio pipeline providers and credentials"
```

---

### Task 7: Build the conditional Settings Panel interface

**Files:**
- Modify: `desktop/ambient-orb/src/renderer/settings.html`
- Modify: `desktop/ambient-orb/src/renderer/settings.css`
- Modify: `desktop/ambient-orb/src/renderer/settings.mjs`
- Modify: `desktop/ambient-orb/test/settings-panel.test.mjs`

**Interfaces:**
- Consumes: version-2 public settings and `secretsPresent` booleans from Task 6.
- Produces: patches using the exact public field names from Task 6; plaintext secrets remain write-only.

- [ ] **Step 1: Write failing panel contract tests**

Assert the HTML includes:

```html
<input type="radio" name="pipelineMode" value="integrated">
<input type="radio" name="pipelineMode" value="cascaded">
<section id="integrated-pipeline">
<section id="cascaded-pipeline" hidden>
```

Assert cascaded cards expose `cascadedEndpointingProvider`, `cascadedAsrProvider`, `cascadedLlmProvider`, the active model input, `cascadedTtsProvider`, and `cascadedTtsVoice`. Assert all seven password fields retain a badge and clear button. Assert the script never reads `.secrets`, ciphertext, or decrypted values.

- [ ] **Step 2: Run the panel contract and verify RED**

```bash
node --test desktop/ambient-orb/test/settings-panel.test.mjs
```

Expected: FAIL because the pipeline controls and new key fields do not exist.

- [ ] **Step 3: Implement conditional pipeline controls**

Render mode and provider fields from `view`. Use `hidden` on the two pipeline sections:

```js
integratedSection.hidden = view.pipelineMode !== 'integrated'
cascadedSection.hidden = view.pipelineMode !== 'cascaded'
```

When `cascadedLlmProvider` changes, select the matching value from `view.cascadedLlmModels`; editing the active model sends a nested patch preserving the inactive provider's model. Reuse `mergePatch` for nested queued changes.

- [ ] **Step 4: Implement provider-aware key labels**

Compute status from public selections, never secret values:

```js
function keyUsage(view) {
  return {
    dashscopeApiKey: view.pipelineMode === 'integrated'
      || view.cascadedLlmProvider === 'qwen' ? '必需' : '当前未使用',
    arkApiKey: view.pipelineMode === 'cascaded'
      && view.cascadedLlmProvider === 'ark' ? '必需' : '当前未使用',
    doubaoBigmodelApiKey: view.pipelineMode === 'cascaded' ? '必需' : '当前未使用',
    doubaoAsrApiKey: view.pipelineMode === 'cascaded' ? '可选覆盖' : '当前未使用',
  }
}
```

Tavily, support-model, and Codex keys retain their existing role labels. Keep password fields blank after render and clear only fields accepted by Main.

- [ ] **Step 5: Style the hierarchy without weakening CSP**

Add compact pipeline tabs and cascaded node cards using only `settings.css`. Do not add inline styles, external images, remote fonts, or new renderer connections. Keep labels and status text in Chinese and state that every non-palette change takes effect on next launch.

- [ ] **Step 6: Run panel and security tests GREEN**

```bash
node --test desktop/ambient-orb/test/settings-panel.test.mjs desktop/ambient-orb/test/main-security.test.mjs desktop/ambient-orb/test/preload.test.mjs
```

Expected: all listed suites PASS.

- [ ] **Step 7: Commit the Settings Panel**

```bash
git add desktop/ambient-orb/src/renderer/settings.html desktop/ambient-orb/src/renderer/settings.css desktop/ambient-orb/src/renderer/settings.mjs desktop/ambient-orb/test/settings-panel.test.mjs
git commit -m "feat(settings): configure integrated and cascaded pipelines"
```

---

### Task 8: Refresh documentation and the parity audit

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`
- Modify: `docs/status.md`
- Modify: `docs/archs/node-runtime-migration/plan.md`
- Modify: `docs/archs/node-runtime-migration/backlog.md`
- Modify: `docs/archs/node-runtime-migration/parity-matrix.md`
- Modify: `docs/releases/node-runtime-migration-unreleased.md`
- Modify: `runtime/node-parity-audit.json`
- Modify: `runtime/test/node-parity-audit.test.ts`
- Modify: `runtime/test/documentation-contract.test.ts`

**Interfaces:**
- Consumes: public environment contract from Task 1 and final production file list from Tasks 2–7.
- Produces: current bilingual setup instructions and a passing parity/documentation gate.

- [ ] **Step 1: Run documentation and parity checks and verify RED**

```bash
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/documentation-contract.test.js runtime/dist/test/node-parity-audit.test.js
npm run check:env-contract
npm run check:node-parity
```

Expected: the parity audit FAILS with stale production/test file inventory. The documentation contract may already pass because Task 1 refreshed generated blocks; do not treat that pass as evidence that the prose is current.

- [ ] **Step 2: Rewrite current pipeline documentation**

Document:

- `integrated` versus `cascaded` as the top-level choice;
- integrated Qwen model/voice/key;
- default `Volcengine ASR -> Qwen qwen-flash -> Volcengine TTS`;
- explicit Ark LLM selection;
- platform-level key reuse and ASR-key fallback;
- Settings Panel conditional behavior; and
- opt-in live smoke commands without claiming they passed.

Remove current-use mentions of `NOVA_AUDIO_AGENT_REALTIME_PROVIDER`, `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL`, and `NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL`.

- [ ] **Step 3: Update the parity audit inventory**

Replace deleted Volcengine owner/assembly paths with new cascaded and integrated units, and replace renamed test entries with their final paths. Keep the audit's intentional-divergence wording explicit: the Python reference is no longer the configuration oracle for this feature.

- [ ] **Step 4: Run documentation and parity checks GREEN**

```bash
npm run check:env-contract
npm run check:node-parity
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/documentation-contract.test.js runtime/dist/test/node-parity-audit.test.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit docs and audits**

```bash
git add README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/status.md docs/archs/node-runtime-migration/plan.md docs/archs/node-runtime-migration/backlog.md docs/archs/node-runtime-migration/parity-matrix.md docs/releases/node-runtime-migration-unreleased.md runtime/node-parity-audit.json runtime/test/documentation-contract.test.ts runtime/test/node-parity-audit.test.ts
git commit -m "docs: document extensible audio pipeline configuration"
```

---

### Task 9: Run the complete verification gate

**Files:**
- Modify only if a failing gate reveals an in-scope defect; add a failing regression test before the fix.

**Interfaces:**
- Consumes: every deliverable from Tasks 1–8.
- Produces: fresh evidence that the implementation and unchanged security boundaries pass together.

- [ ] **Step 1: Run runtime type and lint gates**

```bash
npm run typecheck --workspace @nova-audio-agent/runtime
npm run lint --workspace @nova-audio-agent/runtime
```

Expected: both commands exit 0 with no errors.

- [ ] **Step 2: Run complete runtime and desktop tests**

```bash
npm run test:runtime
npm run test:desktop
```

Expected: both suites report zero failures.

- [ ] **Step 3: Run repository checks and build**

```bash
npm run check
npm run build
```

Expected: environment contract, parity audit, type checking, lint, runtime build, and desktop build all exit 0.

- [ ] **Step 4: Audit requirements and the final diff**

Run:

```bash
git diff --check 80fe511..HEAD
git status --short
rg -n 'NOVA_AUDIO_AGENT_REALTIME_PROVIDER|NOVA_AUDIO_AGENT_VOLCENGINE_ARK_(?:MODEL|SUPPORT_MODEL)' runtime/src desktop/ambient-orb/src .env.example README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md
```

Expected: diff check exits 0; status contains only unrelated pre-existing user files; the retired-variable search finds only the deliberate retired-configuration declaration/test and historical design or release notes that explicitly label it retired.

If Step 1–4 reveals a defect, return to the task that owns that behavior, add a failing regression test there, implement the minimum fix, rerun that task's focused gate, commit its exact test and implementation files, and then restart Task 9 from Step 1. Do not create an empty verification commit.
