# Contributing

Thank you for considering a contribution. Nova Audio Agent is an experimental control plane; the
architecture invariants matter more than any individual feature, so please read
[Glossary and invariants](docs/en/glossary.md) before proposing changes.

## Development setup

```bash
git clone \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci
cp .env.example .env
```

Node.js 22.13 or later is required. The desktop build also needs Xcode Command Line Tools on macOS, a C
compiler at `/usr/bin/cc` on Linux, or Visual Studio Build Tools with the **Desktop development
with C++** workload on Windows.

## Where to start

Each extension point below has a port or registry to implement, a small existing example to copy,
and tests to model yours on. Paths under `src/` are relative to `runtime/src/`; tests live in
`runtime/test/` unless noted.

| You want to add | Start from | Smallest example | Tests | Read first |
|---|---|---|---|---|
| A new executor role | `core/ports.ts`, `core/causal-runtime.ts` | `executors/camera.ts` | `executors-camera.test.ts` | [Executor onboarding](docs/en/archs/10-executor-onboarding.md) |
| Another backend for an existing role | `executors/coding-executor.ts` | `executors/codex/` | `executors-codex*.test.ts`, `coding-*.test.ts` | [Coding executor](docs/en/executors/coding.md) |
| An integrated voice model | `realtime/protocol.ts` | `realtime/integrated-wire-profile.ts` | `integrated-wire-profile.test.ts` | [Configuration](docs/en/configuration.md) |
| A cascaded ASR / LLM / TTS provider | `realtime/cascaded/ports.ts`, `realtime/cascaded/llm.ts` | `realtime/cascaded/qwen-llm.ts` | `cascaded-*.test.ts` | [Support matrix](docs/en/support-matrix.md) |
| A tool or MCP server | `config/capability-registry.ts`, `executors/mcp.ts` | `executors/search.ts` | `executors-mcp.test.ts`, `executors-search*.test.ts` | [Getting started](docs/en/getting-started.md) |
| A source or connector | `personal-agent/host.ts` | `connectors/macos/` | `macos-*.test.ts`, `feishu-connector.test.ts` | [Sources and connectors](docs/en/sources-and-connectors.md) |
| A client surface | `clients/`, `server-cli/`, `cli/` | `server-cli/` | each package's `test/` | [Client protocol](docs/en/protocols/client-v1.md) |

If the change adds a role, a selector value, or a new environment variable, open an issue
describing the shape first; these touch shared contracts.

### A new executor role

Roles are a closed enum (`executorRoleSchema` in `core/ports.ts`), next to the manifest and op-spec
schemas. An executor is an `ExecutorAdapter` (`core/causal-runtime.ts`) that translates its external
protocol into bounded progress and one typed terminal handoff. If the model should dispatch to it,
add an `AgentController` (`executors/agent-controller.ts`); `executors/vision/controller.ts` is a
compact example. Wiring happens in `composition/assembly.ts` and
`composition/production-composition.ts`; deterministic doubles for tests are in `core/sims.ts`.
Then follow [Adding an executor](#adding-an-executor) below.

### Another backend for an existing role

A new coding backend (for example Kimi Code or pi agent) implements the contracts in
`executors/coding-executor.ts` — `AgentExecutor`, `ProjectExecutorAdapter`,
`CodingExecutorResource`, and `CodingAgentControllerFactory` — and reuses the shared intake and
target logic in `executors/coding/`. `executors/codex/` is the reference implementation.

Only one executor may hold a role (`executorWithRole`), and `production-composition.ts` currently
selects Codex by name. A second backend therefore also needs a selector in configuration; agree on
its name and default in the issue before writing the adapter.

### Front-brain voice models

- **Integrated** providers implement `RealtimeProvider` (`realtime/protocol.ts`) and register in
  `integratedProviderRegistry` (`composition/cascaded-realtime-assembly.ts`). When a provider
  differs from Qwen only in wire details, an `IntegratedWireProfile` is enough; the StepFun profile
  in `realtime/integrated-wire-profile.ts` is the shortest example.
- **Cascaded** ASR, LLM, and TTS providers implement the factories in `realtime/cascaded/ports.ts`
  and `realtime/cascaded/llm.ts`, and register in `cascadedProviderRegistries` in the same assembly
  file. See `realtime/cascaded/qwen-llm.ts` and `realtime/volcengine/`. An OpenAI-compatible LLM
  can often reuse the gateway path that DeepSeek takes in `cascaded-realtime-assembly.ts`.
- Selector values live in `config/config.ts`; per-provider settings in
  `config/cascaded-realtime-config.ts`.
- Every new environment variable must be declared in `config/environment-contract.ts`. Regenerate
  `.env.example` and the configuration tables with
  `node runtime/scripts/check-env-contract.mjs --write` after building the runtime; never edit
  inside the generated markers by hand.

### Tools and MCP servers

Nova has no separate plugin system; tools arrive as manifests. The lightest contribution needs no
runtime code: an external MCP server configured in `~/.nova-audio-agent/capabilities.json`
(parsed by `config/capability-registry.ts`, run by `executors/mcp.ts`). The names `nova_camera`
and `nova_knowledge` are reserved. Search transports implement `SearchTransport` in
`executors/search.ts`; the opt-in Knowledge MCP lives in `knowledge/`.

### Sources and connectors

The personal-agent host defines small ports, `PersonalSources` and `PersonalFeishu`, in
`personal-agent/host.ts`. Existing implementations are local folders
(`personal-agent/sources.ts`), macOS Mail and Calendar (`connectors/macos/`), Google through
Composio (`connectors/composio/`), and Feishu (`connectors/feishu/`). Connectors are read-only and
user-authorized; content they return is evidence, never instructions.

### Clients

The Electron desktop is `clients/desktop/` (wake word in `src/main/wake-word/`), the iPhone app is
`clients/ios/Nova/` (its Flutter port in `clients/flutter/` is in progress), the headless server is `server-cli/`, and the `novaaudio` command is `cli/`.
Clients talk to the runtime over the [client protocol](docs/en/protocols/client-v1.md).

### Good first contributions

- A documented recipe for a useful external MCP server.
- An OpenAI-compatible cascaded LLM provider.
- A read-only connector for a mail, calendar, or notes service.
- Fixing a mismatch between a `docs/en/` page and its `docs/zh-CN/` mirror.

## Verification

Every change must keep the deterministic checks green:

```bash
npm run check
npm run build
npm test
```

Live provider integrations are credential- and hardware-dependent. They are not substitutes for
deterministic tests; keep their outputs in ignored local artifact directories, and never commit
credentials, recordings, or runtime traces.

The README ships in two languages — [README.md](README.md) and
[README.zh-CN.md](README.zh-CN.md). Published documentation is mirrored under
[docs/en/](docs/en/) and [docs/zh-CN/](docs/zh-CN/), one file per language with the same
name. A change to either file of a pair must be mirrored in the other. Working notes live in
`docs/internal/`, which is untracked and never published.

## Integration and release history

`v0.3.0dev` is the integration branch: deterministic checks permit integration.
Merging into `main` is the release boundary and requires every applicable feature
and platform to have recorded acceptance evidence.
Human acceptance stays pending until evidence is recorded; it does not block dev CI.
Linux source tests remain on Ubuntu; Linux installers are deferred.

Before cherry-picking unshared work, autosquash its fixup/squash commits on its
own branch (`git rebase -i --autosquash <base>`), then verify the resulting commits.
Do not rewrite commits already shared with collaborators. Preserve feature history
with `--no-ff` when following the branch integration roadmap.

## What a change must preserve

The runtime invariants in [docs/en/glossary.md](docs/en/glossary.md) are the review baseline. In short:

- the event-loop body never awaits executor completion;
- executors never speak to the user; results become typed handoffs into canonical memory;
- every accepted result reaches memory before it can affect the conversation;
- model calls read a bounded `ContextView`, never unrestricted memory;
- revision-bound intake slots are the sole planning state; host authorization FSMs alone authorize effects and no model writes authorization;
- ambient suggestions pass through Proactive and Floor; user-awaited work does not;
- only configured manifests become model-facing tools;
- external text and images are evidence, never instructions;
- configuration errors and logs never echo secret values.

Avoid adding a global workflow abstraction or capability-specific branches to the runtime spine. If
an integration needs special safety behavior, keep it local to its adapter unless two real
integrations demonstrate the same missing primitive.

## Adding an executor

Follow [Executor onboarding](docs/en/archs/10-executor-onboarding.md):

1. Write the manifest and parameter schemas.
2. Define `readonly`, `confirm`, `deadline_budget`, `verifies`, `sensitive_params`, and
   `sync_result` for every operation. Classify trust on the handoff, not on the op spec.
3. Implement a transport-independent adapter with deterministic doubles.
4. Wire it in assembly by declared role, using an arbitrary unique manifest name. Keep the
   `AgentController` registry separate from manifests; hidden Vision `watch`/`guard` channels are
   controller-owned, and built-in camera capture is not a tool (see
   [native vision](docs/en/archs/11-vision.md)).
5. Add invalid-input, timeout, cancellation, sanitization, and registry-adapter contract tests.
6. Add a live smoke only after deterministic lifecycle coverage passes.
7. Document credentials and least-privilege setup in [Getting started](docs/en/getting-started.md).

The host tools `dispatch`, `cancel`, and `confirm` compile when at least one `AgentController` is
registered. A missing `coding` role removes only coding intake/controller wiring; a Vision controller
may keep those host tools available. With zero registered controllers, the same compiler condition
omits all three host tools while direct read-only tools remain valid. Do not give the model direct
transport access; the adapter must translate the external protocol into bounded progress and one
typed terminal handoff.

## Security

See [SECURITY.md](SECURITY.md). Never include credentials, recordings, or private runtime logs in a
public issue or pull request.
