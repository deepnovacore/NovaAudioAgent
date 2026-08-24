# Always-On Codex Project Mode Design

## Status

Approved in conversation on 2026-08-24.

## Problem

Nova currently exposes two overlapping model-visible ways to start Codex work:
`codex__run` starts a new Session in the active workspace, while `codex__project`
manages workspace creation, selection, Session listing, and Session resume. A
standalone request such as “create a Tetris game” can therefore be routed through
`codex__run` and write into the previously active repository instead of creating a
managed project under `~/.nova-audio-agent/workspaces`.

Project confirmation is also currently decided by host-side phrase lists and text
normalization. This requires fixed confirmation wording and makes the host, rather
than the realtime language model, interpret the user's natural-language decision.

## Goals

- Make project mode mandatory for every realtime Codex composition.
- Remove model-visible `codex__run` without removing the private run machinery
  needed to execute and resume Codex threads.
- Give the realtime model one project API for workspace and Session intent.
- Let the realtime model interpret natural confirmation language through a
  dedicated function call with a structured boolean.
- Preserve the host-owned authorization boundary: exact proposal identity,
  expiration, turn binding, one-shot commit authority, and default denial.
- Proactively expose only the active workspace and active Session; query historical
  workspace and Session lists on demand.
- Keep TypeScript and Python implementations behaviorally aligned.

## Non-goals

- No workspace deletion or archival API is added.
- No parallel Codex execution is added; there remains one global live Codex run.
- A Session does not receive a separate checkout or filesystem. Sessions within a
  workspace continue to share that workspace's files and Git state.
- Historical catalogs are not copied into every model turn.
- Ordinary non-realtime Codex execution does not have to become persistent project
  mode; this design governs the realtime Nova client.

## Project hierarchy

The durable hierarchy remains:

```text
Project store
├── active_binding_revision
├── active_workspace_id
├── Workspace
│   ├── canonical filesystem path
│   ├── isolated persistent Codex home
│   ├── active_session_id
│   └── Session[]
│       └── codex_thread_id
└── Workspace...
```

A workspace is the filesystem and project boundary. A Session is a restorable
Codex conversation/thread inside that workspace. Selecting a workspace changes the
global active workspace pointer but does not resume a Session. Resuming a Session
selects both its workspace and its saved Codex thread.

Managed workspaces live beneath `~/.nova-audio-agent/workspaces`. Registered
workspaces, including the repository used to launch Nova, retain their external
canonical paths and are not copied into the managed root. Durable registry state
continues to live in `~/.nova-audio-agent/codex-projects-v1.json`, with per-workspace
Codex homes beneath `~/.nova-audio-agent/codex-homes`.

## Model-visible Codex tools

The realtime project manifest exposes exactly these Codex operations:

- `codex__project`
- `codex__confirm_project_action`
- `codex__steer`
- `codex__status`

`codex__run` is absent from the provider tool schema. Lower-level ordinary/live
adapters and the project adapter's private execution path may retain an internal
run operation; it must not be compilable into the realtime model's tool list.

### `codex__project`

The request shape is:

```ts
interface CodexProjectRequest {
  action:
    | 'list_workspaces'
    | 'create_workspace'
    | 'select_workspace'
    | 'list_sessions'
    | 'start_session'
    | 'resume_session'
  workspace?: string
  session?: string
  work_order?: string
}
```

The action-specific contract is:

| Action | Required | Optional | Confirmation | Meaning |
|---|---|---|---|---|
| `list_workspaces` | none | none | no | Return up to 20 most-recently-used workspaces. |
| `list_sessions` | none | `workspace` | no | Return up to 20 Sessions from the named or active workspace. |
| `create_workspace` | `workspace` | `session`, `work_order` | yes | Create and select a managed workspace; when `work_order` is present, start its first Session after confirmation. `session` is legal only with `work_order`. |
| `select_workspace` | `workspace` | none | yes | Select an existing workspace without resuming or starting work. |
| `start_session` | `work_order` | `session` | no | Create a new Session in the current active workspace and execute the work order. |
| `resume_session` | `work_order` | `workspace`, `session` | yes | Resolve the named or active workspace and Session, then resume its exact Codex thread after confirmation. |

Starting work in a non-active existing workspace is intentionally a two-step flow:
select and confirm the workspace, then call `start_session`. This keeps an implicit
workspace switch out of an otherwise confirmation-free operation.

The project adapter may use a private request variant to execute a confirmed
operation through the existing causal runtime, but that variant is not part of the
JSON schema and is accepted only with the host's unforgeable capability.

### `codex__confirm_project_action`

The confirmation request shape is deliberately small:

```ts
interface ConfirmProjectActionRequest {
  proposal_id: string
  confirmed: boolean
}
```

It is a dedicated function rather than an action inside `codex__project`. The
boolean is the model's structured interpretation of the user's natural expression.
The model must copy `proposal_id` from the current trusted proposal and must not
invent it.

The function covers workspace creation, workspace selection, and Session resume.
Future destructive project operations may reuse the protocol, but they are not
part of this change.

## Routing policy

The realtime instructions teach semantic routing rather than keyword matching:

- A clearly independent complete product or repository request, such as “create a
  Tetris game”, proposes `create_workspace` with an initial work order.
- A request explicitly scoped to the current project uses `start_session`.
- “Continue the current/just-finished task” resolves the active Session and proposes
  `resume_session`.
- A reference to an older or named project first calls `list_workspaces`; a request
  to continue work within it then calls `list_sessions` before proposing resume.
- If multiple workspace or Session candidates remain, Nova asks one concise
  question instead of guessing.
- A request to switch projects without continuing work uses `select_workspace`.

The model may propose names and intent. The host resolves names to exact
`workspace_id`, `session_id`, canonical path, and `codex_thread_id` before creating
a proposal.

## Active context and historical discovery

The realtime model receives one replaceable, host-authored active-project context:

```text
<active_project_context>
workspace=...
session=...
</active_project_context>
```

The context contains display names only, is explicitly described as host state and
not as a user instruction, and is replaced whenever the active workspace or active
Session changes. It never contains the complete historical catalog.

The existing replaceable workspace-context delivery path is extended to carry this
active-project header and, when enabled, the existing workspace-graph header in a
separately labelled section. The active-project section is authoritative current
state; graph suggestions remain low-authority context and cannot authorize a switch.

Historical discovery remains tool-based. `list_workspaces` and `list_sessions`
return fresh, bounded results sorted by recent use. Tool results are model-visible
in the current turn, allowing list -> resolve -> propose chaining without bloating
every session prompt.

## Function-call confirmation protocol

The confirmation protocol follows the `thirdparty/qwen-audio-agent` pattern: a
pending host request supplies an opaque identifier, and the realtime model calls a
dedicated response function after interpreting the user's natural language. It does
not require a fixed phrase.

1. `codex__project` resolves the exact target and creates one pending proposal.
2. The trusted tool result contains `proposal_id`, action, workspace, optional
   Session, expiry, and a natural confirmation summary.
3. The host reserves the next provider user item as the only utterance allowed to
   answer that proposal and binds the model response to that item.
4. If the user's meaning is clearly affirmative or negative, the model calls
   `codex__confirm_project_action` with the exact ID and boolean.
5. If the meaning is unclear, the model does not call the function and asks one
   natural clarification. The proposal remains pending only until its 90-second
   expiry; a completed unclear response releases the reservation for the next user
   item.
6. The host accepts the function only when its response is bound to the reserved
   user item, its ID matches the live proposal, its boolean is structurally valid,
   and the proposal is not expired.
7. `confirmed: false` cancels the proposal. `confirmed: true` converts the proposal
   into an object-identity commit capability that can be claimed exactly once.
8. Missing calls, malformed arguments, stale/wrong IDs, reconnects, transcript
   failures, expiry, duplicate calls, and mismatched turns cannot commit.

During a confirmation turn, all ordinary tool calls remain blocked. The sole
exception is `codex__confirm_project_action`, and it is handled by the realtime host
rather than admitted as a normal causal-runtime task. Its provider tool output is
terminal and idempotent, so the provider is never left waiting for a function
result.

The existing positive/negative phrase tables, punctuation stripping, and
`classifyConfirmation`/`classify_confirmation` functions are removed. ASR text is
still persisted as user-origin evidence, but the host never interprets that text as
the confirmation decision.

## Permanent project mode

`NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED` and the corresponding settings field are
removed. Realtime assembly always requires the project store, managed root,
persistent Codex homes, and packaged project native host. Failure to establish
those resources is a startup configuration error; there is no fallback to an
ordinary model-visible `codex__run` surface.

The managed and state root settings remain configurable and continue to expand
`~` against the real home directory:

```text
NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT=~/.nova-audio-agent/workspaces
NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT=~/.nova-audio-agent
```

## Error handling and safety invariants

- Only one proposal may be pending; a newer proposal invalidates the older one.
- Proposal IDs are host-generated, bounded, opaque, and never accepted after
  replacement or expiry.
- A confirmation call is useless without correlation to the reserved user item and
  its provider response.
- The model cannot supply raw paths, workspace IDs, Session IDs, thread IDs, or
  commit capabilities.
- Workspace identity and filesystem boundaries are revalidated immediately before
  process construction.
- Resume verifies the persisted Session belongs to the resolved workspace and that
  the live Codex thread ID matches the stored thread ID.
- Confirmation defaults to no action. Model speech alone never authorizes a commit.
- Confirmation tool calls are idempotently closed at the provider boundary.
- Reconnect invalidates proposals and pending commit authority.

## Compatibility and migration

- Existing `codex-projects-v1.json`, workspace IDs, Session IDs, and Codex homes
  remain valid; no state-file version migration is required.
- Active workspace/Session binding mutations persist a monotonic
  `active_binding_revision`. Legacy exact-v1 files without that field load at revision
  zero and gain the field on their next binding mutation.
- Legacy `codex-workspaces` to `codex-homes` migration remains intact.
- Existing managed workspace directories are not renamed or moved.
- The removed environment toggle is no longer documented or emitted in config
  fixtures. Supplying it has no effect because project mode is unconditional.
- Ordinary/live adapter unit surfaces may remain for non-realtime internal tests,
  but realtime composition and provider schemas use only the project manifest.

## Verification

Tests must prove:

- Realtime provider schemas do not contain `codex__run`.
- The project schema accepts only the six documented actions and their exact
  per-action fields.
- Independent-project, current-project, historical-workspace, and historical-
  Session evaluation prompts route as specified.
- Active-project context is present, replaceable, and never contains full history.
- Natural affirmative and negative utterances lead the model to emit the dedicated
  boolean function call in provider-level fixtures.
- The host rejects malformed booleans, stale IDs, wrong turns, duplicate calls,
  expired proposals, reconnect-spanning calls, and non-confirmation tools during a
  confirmation turn.
- `confirmed: false` never commits; `confirmed: true` commits exactly once.
- Create-with-work, select, current-workspace start, and resume retain correct
  workspace/Session/thread binding.
- Configuration, TypeScript/Python parity fixtures, documentation, and packaged
  client startup all pass without the project-mode toggle.
