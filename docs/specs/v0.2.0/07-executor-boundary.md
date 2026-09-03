# 07. Executor Boundary

> 摘要：把 Codex 从"散落在内核周边的 46 个文件"收成一个真正插在 `ports.ts` 后面的执行器插件。内核（`runtime/src/**` 除 `executors/**` 与组合根）不得 import Codex 模块、不得对 `'codex'` 字面量分支；执行器按**角色**（`roles: ['coding']`）而非名字被宿主派活；`service.ts` 里两套 Codex 命名的确认状态机（approval、project confirmation）改为执行器无关的宿主能力；桌面线框去掉 `codex.*` 类型名。本卷**不改任何用户可见行为**，也不改模型可见的工具名（工具面整体在 08 换）。边界用 lint + 脚本进 `npm run check`，并用一个 test-only fixture 执行器证明端口真的能插。里程碑 **M1.5a**，在 M1 之后、08 之前。
>
> 依据：2026-09-03 对 `runtime/src` 的三份静态审计（耦合面、端口契约、project/session 流程），行号以当日 `v0.2.0dev` 工作树为准。

## Baseline (today)

What is already clean:

- `runtime/src/ports.ts`, `causal-runtime.ts`, `assembly.ts`,
  `production-realtime-assembly.ts` contain **zero** `codex` references.
- `assembly.ts` `resolveExecutors` (110–134) already looks adapters up by
  `manifest.name`; the only literal union is `config.ts:14`
  `z.enum(['fast_sim','slow_sim','codex'])`.
- `search.ts` and `camera.ts` are clean adapters: contract + their own
  transport, no `realtime/` or Codex imports.
- `environment-contract.ts:5` already has an `owner` axis
  (`'core' | 'codex' | 'search' | …`) for environment variables.

Where Codex leaks (31 core files, three clusters):

1. **Realtime service.** `runtime/src/realtime/service.ts` carries ~1700
   Codex-specific lines: the approval state machine (`CODEX_APPROVAL_TOOL`,
   `#syncCodexApproval` … `#invalidateCodexApproval`, ~4073–4886, ~40
   private methods) and the project-confirmation state machine
   (`#syncProjectConfirmationIsolation` … `#invalidateProjectConfirmation`,
   ~3912–5931). Both are host confirmation FSMs bound to `codex__` tool names.
   `tool-schema.ts:171–173` special-cases `manifest.name === 'codex'` for
   `confirm_project_action` / `confirm_codex_approval`.
2. **Host dispatch that only knows Codex.** `realtime-assembly.ts:823–831`
   dispatches intake as `{executor: 'codex', op: 'project'}` and appends to
   `memory.append('codex', …)`; `confirmed-project-capability.ts:34–46`
   admits only `executor === 'codex' && op === 'project'`;
   `realtime/bridge.ts:106–109, 210–211` branch on the same pair;
   `model-adapters.ts:163` drops tools where `binding.executor !== 'codex'`.
3. **Desktop wire.** `desktop-wire.ts:202–363` emits `codex.state`,
   `codex.project`, `codex.approval`; `desktop.ts:167–171` accepts
   `codex.approval_decision`; `desktop-bridge.ts` holds `#codexOutbound` /
   `#projectOutbound` / `#approvalOutbound` latest-slots.

Reverse dependency: `executors/codex-project-live.ts` imports
`../realtime/codex-approval.js`, `../realtime/intake.js`,
`../realtime/project-confirmation.js` — an executor reaching into the
conversation layer.

Speech copy: `realtime/evidence.ts:196–198, 244–250` selects
`finalSpeechView` (Codex wording) when `channel === 'codex'`, else
`genericFinalSpeechView`. `desktop-progress.ts:53` maps `executor === 'codex'`
to the label `Codex`.

Barrel: `runtime/src/index.ts:5–32` re-exports every `codex-*` module.

Sixteen top-level `codex-*.ts` files split into: (i) transport / protocol
(`codex-app-server-schema`, `-transport`, `codex-protocol`, `codex-jsonl`,
`codex-safe-json`, `codex-turn-projection`, `codex-process-owner`,
`codex-credential-snapshot`, `codex-windows-guardian`); (ii) **host**
persistence that is only Codex by name (`codex-project-store.ts`, 3574 lines:
workspaces, sessions, locks, `codex-projects-v1.json`); (iii) config /
validation (`codex-host-config`, `codex-launch-profile`, `codex-version`,
`codex-contract`); composition (`codex-factory`, `codex-production-host`).

## Goals

1. **One import surface.** Everything Codex-specific lives under
   `runtime/src/executors/codex/` and is reachable only through
   `executors/codex/index.ts`. Core never imports it; composition roots do.
2. **Role, not name.** The host dispatches coding work to "the configured
   executor with role `coding`", never to the string `'codex'`.
3. **Host-owned confirmations.** Approval and project confirmation become
   executor-agnostic host capabilities. An executor *declares* that it needs
   an approval surface; it does not own the tool or the FSM.
4. **Executors do not import the conversation layer.** The dependency arrow
   is `realtime → ports ← executors/*`, never `executors/* → realtime`.
5. **Enforced, not aspirational.** A lint rule plus a boundary script run in
   `npm run check`; a test-only fixture executor exercises the full port.
6. **Behaviour-preserving.** No user-visible change: same tools, same wire
   semantics under new type names, same approval prompts, same live smokes.

## Non-goals

- Renaming or reshaping the model-visible tools `codex__project`,
  `codex__confirm_project_action`, `codex__confirm_codex_approval`,
  `codex__steer`, `codex__status`. The whole model-facing surface changes
  once in [08](08-project-and-work.md) so prompt text and tests move once.
- A second production executor (ACP or otherwise). The fixture executor is
  test-only. ACP remains out of v0.2.0.
- Changing Windows approval behaviour, launch profiles, or the broker shapes
  agreed in [01](01-codex-approvals.md).
- Merging approval and project confirmation into one tool (rejected in the
  2026-09-02 handoff; still rejected).
- Renaming user-facing environment variables (`NOVA_AUDIO_AGENT_CODEX_*`,
  `CODEX_HOME`). Ownership moves; names do not.

## Boundary rules

Definitions:

- **Core**: every file under `runtime/src/**` except `runtime/src/executors/**`
  and the composition roots below.
- **Composition roots** (may import any executor package): `runtime/src/cli.ts`,
  `runtime/src/desktop-entry.ts`, `runtime/src/production-realtime-assembly.ts`,
  and `runtime/src/executors/index.ts` (the registry).
- **Executor package**: `runtime/src/executors/<name>/**` with exactly one
  public module `index.ts`.

Rules (each is machine-checked; see Enforcement):

- R1. Core must not import from `runtime/src/executors/<name>/**`.
- R2. Core must not compare, switch, or branch on the literal `'codex'` (or any
  other executor name). Executor identity reaches core only as
  `manifest.name`, `manifest.roles`, `manifest.display_name`, `delegate.executor`.
- R3. Executor packages must not import from `runtime/src/realtime/**`,
  `runtime/src/desktop*.ts`, or `runtime/src/*-assembly.ts`. They may import
  `ports.ts`, `causal-runtime.ts` types, `memory.ts` types, `events.ts`,
  `clock.ts`, text/JSON utilities, and their own package.
- R4. `runtime/src/index.ts` re-exports executor packages only via
  `executors/index.ts`; no direct `codex-*` re-export.
- R5. Environment variables owned by an executor are declared by that
  executor's package and merged into `environment-contract.ts` rows through the
  existing `owner` axis; core rows never carry `owner: 'codex'`.

Allowed residue after this volume (must be listed in the boundary script's
allowlist with a reason): the string `'codex'` inside `executors/codex/**`;
the user-facing env var names; the `owner: 'codex'` tag on those rows;
fixture / test files under `runtime/test/**`.

## Manifest delta (`ports.ts`)

```ts
export const executorManifestSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().min(1).max(40),          // new; wire + bubble label
  roles: z.array(z.enum(['coding'])).default([]),    // new; host routes by role
  approvals: z.boolean().default(false),             // new; needs approval surface
  ops: z.array(opSpecSchema),
  policy: handoffPolicySchema,
  confirm_ttl: z.number().finite().nonnegative().default(0),
}).strict()
```

- `roles` is the only way the host finds a coding executor. Assembly fails
  with `AssemblyError('no executor with role coding')` when intake is enabled
  and none is registered, and with `'multiple executors with role coding'`
  when more than one is (v0.2.0 admits exactly one).
- `approvals: true` tells assembly to attach the host approval surface
  (`host__confirm_approval` tool, `executor.approval` wire, approval FSM). The
  executor exposes its broker through a typed port (below); the FSM never
  imports the broker's concrete class.
- `confirm_ttl` was never read anywhere (`ports.ts:132`); delete it.
- `OpSpec.confirm` is never consulted by dispatch (`causal-runtime.ts`); keep
  it but document that host confirmations are a separate mechanism, or delete
  it in 08 when the project op goes away. Decision deferred to 08.

### Approval port

Move the approval *types* out of `realtime/codex-approval.ts` into a new
executor-agnostic `runtime/src/approval-port.ts`:

```ts
export interface ApprovalRequest {
  readonly approval_id: string
  readonly kind: 'file_change' | 'command_execution' | 'network' | 'permissions'
  readonly operation_summary: string          // already redacted by executor
  readonly local_detail: string | null        // renderer-only, redacted
  readonly allowed_decisions: readonly ('accept' | 'acceptForSession' | 'decline')[]
  readonly expires_at: number
}
export interface ApprovalBroker {
  subscribe(listener: (request: ApprovalRequest) => void): () => void
  decide(approval_id: string, decision: 'accept' | 'acceptForSession' | 'decline'): Promise<'applied' | 'expired' | 'unknown'>
}
export interface ExecutorAdapter {
  readonly manifest: ExecutorManifest
  readonly approvals?: ApprovalBroker            // present iff manifest.approvals
  dispatch(...): Promise<ExecutorHandoff>
}
```

The Codex broker (`executors/codex/approval-broker.ts`, today's controller
logic) implements this port. `service.ts` keeps its FSM but talks to
`ApprovalBroker` only; the ~40 `#…CodexApproval` methods are renamed
`#…Approval` with no behaviour change (mechanical rename, covered by the
existing approval tests).

### Project confirmation

`realtime/project-confirmation.ts` already contains no Codex logic (only a
file comment). It stays a host module. `confirmed-project-capability.ts:34–46`
changes from `executor === 'codex' && op === 'project'` to
`executor === codingExecutor.manifest.name && op === 'project'`, where
`codingExecutor` is resolved by role at assembly. Same for
`realtime-assembly.ts:823–831` and `realtime/bridge.ts:106–109, 210–211`.

## Package layout

```
runtime/src/executors/
  index.ts                     # registry: name → factory; used by composition roots
  fixture/                     # test-only executor (see below); excluded from production build? no — shipped but never selected
  codex/
    index.ts                   # public: createCodexExecutor(config) → {adapter, envRows, diagnostics}
    contract.ts                # was codex-contract.ts
    adapter.ts / adapter-live.ts / adapter-project.ts / common.ts
    approval-broker.ts         # was realtime/codex-approval.ts (controller half)
    transport/                 # app-server-schema, -transport, protocol, jsonl, safe-json, turn-projection
    process/                   # process-owner, credential-snapshot, windows-guardian, launch-profile, version
    host-config.ts             # was codex-host-config.ts
    production-host.ts         # was codex-production-host.ts
    factory.ts                 # was codex-factory.ts
```

`codex-project-store.ts` → `runtime/src/project-store.ts` (host). Field and
file renames inside the store are limited to `codex_home_key` →
`executor_home_key` and the on-disk file name staying `codex-projects-v1.json`
(no migration in this volume; 08 owns store schema changes if any).
`managed-workspace-maintenance.ts` and `workspace-graph/factory.ts` import the
host store, which removes their two Codex imports.

`index.ts` barrel: replace lines 5–32 with `export * from './executors/index.js'`
plus the host store export.

## Config delta

- `config.ts:14`: `executorNameSchema` becomes `z.string().min(1)`; validity is
  decided by `resolveExecutors` at assembly (already throws on unknown names).
- `config.ts:87–100, 240, 315–337, 605–606` (Codex keys and
  `parseCodexApprovalMode`): move parsing into `executors/codex/host-config.ts`;
  `config.ts` keeps an opaque `executor_config: Record<string, unknown>` slice
  that each executor package parses with its own zod schema at factory time.
  Settings v4 migration is untouched (keys do not change).
- `environment-contract.ts`: rows with `owner: 'codex'` and the `CODEX_HOME`
  `host_private` row move to `executors/codex/env-rows.ts` and are concatenated
  by `environment-contract.ts` from `executors/index.ts`. Generated blocks must
  be byte-identical (`check:env-contract` guards this).
- `diagnostics.ts:142–146` (`executors.includes('codex')` → workspace check)
  becomes a per-executor `diagnose()` hook on the package export.

## Desktop wire delta

| Today | After | Payload change |
|---|---|---|
| `codex.state {state}` | `executor.state {executor, display_name, state}` | adds identity |
| `codex.project {…}` | `project.state {…}` | none |
| `codex.approval {…}` | `executor.approval {executor, display_name, …}` | adds identity |
| `codex.approval_decision` (inbound) | `executor.approval_decision {executor, approval_id, approved, scope?}` | adds `executor` |
| `project.confirmation_decision` (inbound) | unchanged | — |

Renderer changes are label-only: `desktop-progress.ts:53` and the state label
read `display_name` from the frame instead of hard-coding `Codex`. Bubble
frame `executor.progress` (05) already carries `executor`; add `display_name`.

## Speech copy

`evidence.ts` keeps one path. Executor-specific phrasing, if still wanted,
comes from `manifest.display_name` substitution into the generic templates
(`"{display_name} 已完成"` etc.). The Codex-only `CODEX_PROGRESS_KEYS` list
becomes a generic `progress.summary` field the Codex adapter already emits.
Golden-tested transcripts must be identical for the Codex case.

## Fixture executor (boundary proof)

`runtime/src/executors/fixture/` ships a deterministic executor registered
through the same `executors/index.ts` path as Codex, with
`roles: ['coding']`, `approvals: true`, ops `run`, `steer`, `status`,
`project` mirroring the Codex project manifest shapes, and a scripted
`ApprovalBroker`. It is selectable only when `NODE_ENV !== 'production'` or
via `NOVA_AUDIO_AGENT_EXECUTORS=fixture` in tests. A single test
(`runtime/test/executor-boundary-fixture.test.ts`) drives: assembly by role,
intake dispatch, progress, an approval round-trip through `host__confirm_*`,
a project confirmation round-trip, and terminal handoff — **with no Codex
module loaded** (asserted via `require.cache` / module registry inspection).
If that test cannot be written without importing Codex, the boundary is not
real and this volume is not done.

## Enforcement

- ESLint (`eslint.config.mjs`): add a block for
  `runtime/src/**/*.ts` (excluding `executors/**` and composition roots) with
  `no-restricted-imports` patterns `**/executors/*/**`; and a block for
  `runtime/src/executors/**` restricting `**/realtime/**`, `**/desktop*`,
  `**/*-assembly*`.
- Script `runtime/scripts/check-executor-boundary.mjs --check` (same shape as
  `node-parity-audit.mjs`): scans core for the regex
  `['"]codex['"]|codex__|Codex[A-Z]` and fails on any hit not in the allowlist
  file `runtime/scripts/executor-boundary-allowlist.json` (each entry: path,
  pattern, reason). Wired as `check:executor-boundary` in
  `package.json` `check`.
- Acceptance: `rg -i codex runtime/src --glob '!executors/codex/**' --glob '!executors/index.ts'`
  returns only allowlisted lines.

## Implementation touchpoints

| Area | Files |
|---|---|
| Port | `runtime/src/ports.ts`, new `runtime/src/approval-port.ts` |
| Registry | new `runtime/src/executors/index.ts`, `runtime/src/executors/codex/index.ts`, `runtime/src/executors/fixture/**` |
| Moves | 16 `codex-*.ts`, `executors/codex*.ts`, `realtime/codex-approval.ts` → `executors/codex/**`; `codex-project-store.ts` → `project-store.ts` |
| Role routing | `realtime-assembly.ts`, `confirmed-project-capability.ts`, `realtime/bridge.ts`, `model-adapters.ts`, `tool-schema.ts` |
| Service | `realtime/service.ts` approval FSM → `ApprovalBroker`; rename only |
| Config | `config.ts`, `environment-contract.ts`, `diagnostics.ts`, `codex-host-config.ts` (moved) |
| Wire | `desktop-wire.ts`, `desktop.ts`, `desktop-bridge.ts`, `desktop-service.ts`, `desktop-progress.ts`; renderer label sites |
| Speech | `realtime/evidence.ts` |
| Barrel | `runtime/src/index.ts` |
| Checks | `eslint.config.mjs`, `runtime/scripts/check-executor-boundary.mjs`, `package.json` |
| Tests | relocate `runtime/test/codex-*.test.ts` alongside; new fixture test; wire schema tests |

## Verification checklist

Deterministic:

- [ ] `npm run check` includes `check:executor-boundary` and passes with an
      allowlist containing only env var names / owner tags.
- [ ] ESLint restricted-import blocks fail on a deliberately planted core →
      `executors/codex` import and executor → `realtime` import (negative
      tests in `runtime/test/eslint-boundary.test.ts` using ESLint's API).
- [ ] Fixture executor test passes with no Codex module in the module registry.
- [ ] Assembly by role: zero coding executors with intake enabled →
      `AssemblyError`; two → `AssemblyError`; one → dispatch reaches it.
- [ ] Manifest schema: `roles`, `display_name`, `approvals` validated;
      `confirm_ttl` removed; existing manifests updated.
- [ ] Approval FSM tests pass unchanged against a fake `ApprovalBroker`.
- [ ] Wire schema tests for `executor.state` / `project.state` /
      `executor.approval` / `executor.approval_decision`; old type names
      rejected.
- [ ] `check:env-contract` generated blocks byte-identical before/after.
- [ ] Speech goldens identical for Codex transcripts.
- [ ] Full `npm test` (runtime, desktop, cli) green.

Live (behaviour must be identical to the M1 validation table in
[IMPLEMENTATION.md](IMPLEMENTATION.md)):

- [ ] Codex 0.152.0 config smoke: real app-server, isolated homes, all three
      launch profiles, no model turns.
- [ ] macOS headset: one coding task through `codex__project` with a
      `file_change` approval accepted by voice and one declined via the banner.
- [ ] Desktop renderer smoke (`renderer-progress-smoke.mjs`) at 100/125/150%
      with the new frame types; state label shows `Codex` from `display_name`.
- [ ] Windows: approval path with `ask` profile; ACL / job-object tests
      unchanged.

## Decision-record delta (apply on merge)

| Decision | Chosen boundary | Rejected alternative |
|---|---|---|
| Executor identity in core | Core sees `manifest.name / roles / display_name` and `delegate.executor` only; routing by `roles: ['coding']`; lint + script enforce | Branching on `'codex'`; a `switch` per executor in assemblies; boundary by convention only |
| Confirmation ownership | Approval and project confirmation are host capabilities; executors declare `approvals: true` and expose an `ApprovalBroker` port | Executor-owned confirmation tools; one merged confirm tool (still rejected) |
