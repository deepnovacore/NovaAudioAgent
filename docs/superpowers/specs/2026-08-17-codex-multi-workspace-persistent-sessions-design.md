# Codex Multi-Workspace and Persistent Sessions Design

Date: 2026-08-17

## Problem

Phase 1 prevents independent Codex work orders from sharing an implicit thread,
but Nova still starts with one fixed filesystem workspace. Users cannot create,
select, or resume projects by voice, and a restart loses the user's active
project selection.

Multi-workspace support must not turn a probabilistic speech-model decision into
filesystem authorization. It must also preserve the useful Phase 1 invariant:
independent work starts with independent history, while history is reused only
after the user explicitly selects and confirms a prior Session.

## Goals

1. Persist multiple logical workspaces without exposing canonical paths to the
   realtime frontend.
2. Import the existing configured Codex workspace and preserve it as the default
   project during migration.
3. Allow safe voice creation under one configured managed root, defaulting to
   `~/NovaWorkspaces`.
4. Persist multiple named project Sessions per workspace and restore their real
   Codex history with `thread/resume` across app-server processes and Orb
   restarts.
5. Persist the active workspace and active Session across restarts.
6. Require a host-verified voice confirmation before creating or switching a
   workspace or restoring hidden Session history.
7. Keep one global Codex task slot so existing status, steering, progress, and
   Orb lifecycle semantics remain stable.
8. Add only one provider-visible function beyond the existing Codex tools.

## Non-goals

- Concurrent Codex work across workspaces or Sessions.
- Voice deletion, relocation, or registration of an arbitrary existing path.
- Migrating, retargeting, or cancelling an accepted task when the active project
  changes.
- Allowing an LLM-generated path, workspace ID, Session ID, or thread ID to act
  as authority.
- Silently falling back to a new thread when a requested Session cannot be
  resumed.
- Adding a second LLM coordinator.

## Architecture

The existing Qwen realtime model remains the only semantic model. It may propose
a logical project operation, but it cannot commit a filesystem or history
boundary change. A deterministic host router owns lookup, confirmation,
persistence, validation, and task binding.

```text
Qwen realtime
  -> codex.run or codex.project proposal
  -> ProjectCodexAdapter
       -> PendingConfirmationController
       -> WorkspaceRegistry
       -> ProjectSessionRegistry
       -> workspace-scoped Codex transport factory
  -> Runtime / DelegateLedger / progress / handoff
```

The router is ordinary Python code, not an LLM. It does not infer paths or pick
among ambiguous names. Model output is a proposal that is either resolved
exactly and confirmed by the user or refused.

## Persistent State

One versioned state store atomically persists workspace and Session metadata so
that a workspace update and its active-Session update cannot be partially
committed. Its default files are
`~/.nova-audio-agent/codex-projects-v1.json` and a sibling lock file; tests and
administrative deployments may override their parent through settings.

The top-level state contains:

```text
version
active_workspace_id
workspaces: workspace_id -> WorkspaceRecord
sessions: session_id -> ProjectSessionRecord
```

`WorkspaceRecord` contains:

```text
workspace_id             opaque host-generated ID
display_name             bounded user-visible name
normalized_name          host normalization key
canonical_path           private absolute path
origin                   managed | registered
codex_home_key           private opaque state-directory key
active_session_id        private nullable Session reference
created_at
last_used_at
```

`ProjectSessionRecord` contains:

```text
session_id               opaque host-generated ID
workspace_id             immutable owning workspace
display_title            bounded user-visible title
normalized_title         lookup key within the workspace
codex_thread_id          private nullable Codex thread ID
state                    starting | ready | unavailable
created_at
last_used_at
```

Canonical paths, opaque IDs, Codex thread IDs, and Codex-home keys never enter
provider schemas, spoken output, captions, memory summaries, trace projections,
or Ambient Orb renderer payloads.

The registry file, interprocess lock file, and copied credential files use mode
`0600`. State directories and per-workspace Codex homes use mode `0700`.
Every load-modify-save transaction holds the state lock, reloads the current
version under that lock, writes and fsyncs a same-directory temporary file,
atomically renames it, and fsyncs the parent directory. This prevents the live
service and trusted CLI from losing one another's updates. Ownership or mode
violations fail closed.

## Workspace Boundaries

Each workspace has a distinct persistent Codex home below the configured project
state root:

```text
<project-state-root>/codex-workspaces/<codex_home_key>
```

This keeps persisted histories for different workspaces physically separate.
Saved-login credentials are copied with owner-only permissions using the same
source and redaction rules as the current private-home transport. API-key
deployments continue to use the configured key without persisting it in the
registry.

On every use, the host:

1. Resolves the registered canonical path again.
2. Requires an existing directory.
3. Rejects symlink or parent changes that escape the recorded boundary.
4. Runs the current Codex preflight and configuration validation.
5. Constructs a transport with exactly that workspace and its dedicated Codex
   home.

The existing `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` is imported as the first
`registered` workspace when project mode is enabled and the registry has not
already imported it.

## Managed Voice Creation

`NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT` defaults to `~/NovaWorkspaces`. Voice
creation accepts only a display name, never a path.

If the managed root does not exist, the host creates that exact directory with
mode `0700` before resolving it. It refuses an existing root unless it is a real
directory, is owned by the current user, is not group- or world-writable, and
the configured root entry itself is not a symlink. Candidate containment checks
use the canonical root.

The host applies Unicode NFKC, trims and collapses whitespace, and case-folds to
produce the exact lookup key. It derives the direct-child directory name from a
sanitized display prefix plus an opaque host-generated suffix; the raw model
string is never joined to the managed root as a path. It rejects:

- empty or control-only names;
- path separators, traversal components, drive or URI syntax;
- reserved names;
- names or slugs that collide after normalization;
- a pre-existing child at the candidate path (voice creation never adopts it);
- a managed root that is a symlink or not an owner-controlled directory;
- any candidate that is not a direct child of the canonical managed root.

Creation is committed only after confirmation. The host creates one direct child
directory and atomically adds its workspace record. If registry persistence
fails, it removes the newly created directory only when it is still empty. A
later task failure never rolls the workspace back. Voice deletion is not
provided.

Existing directories outside the managed root are added only through trusted
local administration:

```text
nova-audio-agent workspace list
nova-audio-agent workspace register <display-name> <path>
```

## Project Sessions and Codex History

One workspace may contain multiple Sessions. A normal `codex.run` always creates
a new Session, makes it active for that workspace, and starts a non-ephemeral
Codex thread with `thread/start` and `ephemeral: false`. `codex__run` gains only
one optional `session` string of 1..120 printable characters. The host uses a
generic timestamped `Task` title when it is absent or fails public-metadata
redaction, and adds a deterministic numeric suffix on collision. A title is
presentation metadata only and never selects authority.

The Session is first persisted as `starting` with a null thread ID. After
`thread/start` succeeds, the host persists the returned thread ID and `ready`
state before sending `turn/start`. On restart, a `starting` record with no thread
ID becomes `unavailable`. Once a thread ID is safely recorded, a failed or
uncertain turn retains a resumable `ready` Session unless later resume validation
proves its persisted history unavailable.

A previous Session is reused only through a confirmed resume proposal. A fresh
app-server process starts with the owning workspace's persistent Codex home and
calls `thread/resume` by the private thread ID. The request supplies the
canonical cwd, the runtime workspace root, the named permission profile, and
`excludeTurns: true`.

Before `turn/start`, the host verifies that the response has:

- the expected thread ID;
- the expected canonical cwd;
- the expected runtime workspace root;
- the expected active permission profile;
- no unexpected server request or unsupported protocol field.

Any mismatch refuses the task and marks the Session unavailable. Missing or
corrupt persisted history also marks it unavailable. Nova never starts a new
thread and reports it as a successful resume.

Each work order still owns a new app-server process lifetime. Clean completion,
failure, timeout, and cancellation tear down that process and its RPC state but
retain the workspace Codex home and registered thread history.

Startup may prewarm only the persisted active workspace. Selecting another
workspace invalidates and tears down a mismatched unused prewarm; it is never
retargeted. As in Phase 1, later work orders may pay the full process startup
cost.

## Immutable Task Binding and Serialization

At acceptance, the router snapshots:

```text
delegate_id -> workspace_id + session_id + operation
```

This binding is host-created and immutable. Later project selection affects
only future tasks. The global Codex run lock remains authoritative: a second
run while one is active receives the existing bounded busy refusal. Same-turn
steering targets only the active bound transport; status remains the current or
most recent Codex task.

`list`, `sessions`, confirmed workspace selection, and confirmed `create`
without a work order do not take the global run slot, so a user may choose the
workspace for the next task while the current one continues. A confirmed
`resume`, or `create` with an initial work order, must atomically acquire the
global run slot before mutating active project state. If the slot is busy, the
operation is refused with no workspace, Session, or active selection mutation.
The slot is rechecked at confirmation time rather than reserved for the lifetime
of a proposal.

Concurrency, task-specific status, task-specific steering, and task-specific
cancellation are intentionally deferred.

## Provider Tool Surface

The provider sees four Codex functions total:

```text
codex__run
codex__project
codex__status
codex__steer
```

Only `codex__project` is new. It uses a flat schema:

```text
action       list | create | select | sessions | resume
workspace    optional display name, 1..80 printable characters
session      optional Session title, 1..120 printable characters
work_order   optional complete objective, 1..4000 printable characters
```

The object rejects unknown properties. The single `project` OpSpec is marked
non-readonly conservatively because some actions can prepare mutations, while
the adapter keeps `list` and `sessions` side-effect free. It returns synchronously
and does not occupy the global Codex run slot.

The host performs action-specific validation:

- `list`: no optional fields; return public workspace names and active state.
- `sessions`: optional workspace; return public Session titles and states.
- `create`: require workspace; optional work order; create a pending proposal.
- `select`: require workspace; create a pending proposal.
- `resume`: require a complete work order; optional workspace and Session title;
  resolve defaults from active state, then create a pending proposal.

After confirmation, `create` creates and selects the workspace; when a work order
is present it also creates a new Session and dispatches that work. `select`
changes only the active workspace and preserves that workspace's last active
Session. `resume` selects the resolved workspace and Session and dispatches the
given work order into the persisted thread. A proposal that omits an action's
required fields is rejected before confirmation.

`codex.run` has one meaning: create new independent work in the active workspace.
Its optional Session title is cosmetic; it cannot choose a path or resume
history.

The prompt teaches one stable distinction: new work uses `run`; listing,
creating, switching, or continuing project context uses `project`.

## Host-Verified Confirmation

`create`, `select`, and `resume` never mutate durable state or start a task when
the provider calls them. They create exactly one in-memory proposal containing
the fully resolved public names, private host bindings, the complete work order
when applicable, the originating turn, an expiry, and a single-use nonce that is
never returned to the provider.

The synchronous project result contains a host-generated, concrete confirmation
prompt such as:

> 准备切换到天气看板，并继续 Session“登录修复”，请确认或取消。

Qwen supplies both realtime reasoning and ASR, so its transport necessarily sees
the confirmation audio. The security boundary is instead enforced at host
admission: while a proposal is pending, `RealtimeService` reserves the next real
user speech item as a confirmation turn at `UserSpeechStarted`. Provider audio,
text, and tool calls causally associated with that item are fenced and cannot be
spoken, admitted, or dispatched. On `UserTranscriptFinal`, the host records the
utterance as user evidence and classifies it before the normal tool bridge can
use it. The host then requests the appropriate fixed confirmation, retry, or
cancellation response. Qwen is therefore allowed to transcribe the answer but
cannot authorize or commit the operation.

If a provider emits a tool call before that item's transcript final, the service
holds and then refuses it as part of the reserved confirmation turn. Reconnect,
missing item correlation, or ASR failure cancels the proposal rather than
falling back to ordinary model routing.

Confirmation is a deterministic whole-utterance grammar, not an LLM
classification.

Normalization removes whitespace and punctuation. Around, but never inside, the
core phrase it permits only these optional discourse tokens: leading `嗯`,
`嗯嗯`, `好`, `好的`, `那`, or `那就`; and trailing `啊`, `呀`, `哦`, or
`啦`. An affirmative utterance must otherwise equal one of these positive forms:

```text
确认 | 确认执行 | 可以 | 可以执行 | 同意 | 没问题 |
就这么做 | 按这个来 | 开始吧 | 执行吧 | 做吧
```

Negative forms include:

```text
取消 | 不确认 | 不要 | 不行 | 先不要 | 先别 | 算了 | 停止
```

Explicit negative terms take precedence. The host does not use substring fuzzy
matching, edit distance, or an LLM. A first unrecognized short reply produces a
clarification with natural examples. A second unrecognized reply cancels the
proposal. Proposals also expire after 90 seconds and are invalidated by provider
replacement, Orb restart, or a newer proposal.

After an affirmative match, the host first consumes the single-use nonce, then
commits through a typed `ConfirmedProjectOperation` API shared by the
confirmation controller and project adapter. For operations that launch work,
that API creates a host-owned `DelegateRequest` whose `origin_ref` is the
recorded confirmation utterance and submits it through
`Runtime.dispatch_external`; the ordinary Runtime admission, DelegateLedger,
deadline, progress, handoff, and wake paths remain authoritative. The confirmed
operation API and its commit-only adapter methods are not OpSpecs and never enter
provider schemas, so confirmation does not depend on the model making another
tool call. Direct calls without a live consumed proposal nonce are refused.

## Failure and Recovery

- Missing, duplicate, or ambiguous workspace and Session names are refused; the
  host returns bounded public candidates and never guesses.
- Registry corruption, unsafe ownership, or unsafe modes fails closed and
  preserves the original file. Nova does not overwrite it automatically.
- A create rollback removes only the exact newly created empty directory.
- A failed task retains its workspace and Session.
- A failed resume retains the record as unavailable for diagnosis and prevents
  further resume attempts until trusted administration or a future repair flow
  resolves it.
- An active task continues with its immutable binding after a workspace switch.
- A busy refusal for confirmed `resume` or `create` with work leaves active
  project state unchanged; the user may retry after the current task completes.
- Feature disablement ignores, but does not delete, registry and Codex history.

## Configuration and Compatibility

Project mode is guarded by:

```text
NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED=false
```

It defaults off so current deployments retain Phase 1 behavior. Additional
settings are:

```text
NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT=~/NovaWorkspaces
NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT=~/.nova-audio-agent
```

When disabled, assembly constructs the current single-workspace adapter and
ephemeral private Codex homes. When enabled, assembly imports the configured
workspace and constructs `ProjectCodexAdapter`. Disabling the feature later
does not delete registry data or persistent Codex homes.

## Ambient Orb Projection

The backend may project only:

```text
workspace_display_name
session_title
pending_confirmation
```

The Orb displays the current workspace and Session in its status/menu surface.
It never receives paths, opaque IDs, registry records, Codex-home locations, or
thread IDs.

## Verification

### Registry and filesystem

- versioned load/save, atomic rename, fsync, and `0600`/`0700` enforcement;
- interprocess lock serialization and reload-under-lock lost-update tests;
- initial configured-workspace migration and idempotent restart;
- canonical path revalidation, symlink escape rejection, name/slug collision;
- voice creation direct-child enforcement and empty-directory-only rollback;
- corrupt or unsafe registry fail-closed behavior.

### Confirmation

- table-driven positive, negative, particle, punctuation, and mixed-negation
  cases;
- negative precedence and rejection of utterances containing extra objectives;
- early provider tool calls and response audio from a reserved confirmation turn
  are fenced before admission or playback;
- ASR failure, missing correlation, and reconnect cancel rather than downgrade
  into model authorization;
- zero mutation before confirmation;
- single-use commit, 90-second expiry, retry limit, replacement and restart
  invalidation;
- confirmed work enters Runtime/DelegateLedger rather than bypassing lifecycle
  tracking.

### Session persistence

- non-ephemeral `thread/start` stores a private thread ID;
- crash recovery converts an incomplete `starting` Session to `unavailable`;
- process teardown retains the workspace Codex home;
- a new process successfully performs `thread/resume` after restart;
- mismatched thread ID, cwd, workspace roots, or permission profile prevents
  `turn/start`;
- missing history marks unavailable without fallback;
- independent `run` calls create distinct Sessions and threads;
- only confirmed resume reuses a thread.

### Routing and public boundaries

- switching affects future work only;
- switching while work is active does not retarget status, steering, or the
  accepted task;
- launching project work rechecks the one global task slot and mutates nothing
  on a busy refusal;
- task bindings remain immutable;
- one global run lock continues to reject concurrency;
- status and steering target only the active bound transport;
- provider, speech, caption, memory, trace, and Orb projections contain no
  canonical paths or private IDs;
- disabled mode preserves all Phase 1 behavior.

### Qwen tool selection

An opt-in realtime evaluation corpus covers ordinary new work, workspace list,
creation with and without initial work, selection, Session listing, explicit
continuation, ambiguous names, negation, and unrelated utterances. The safety
gate is host-side: an incorrect `create`, `select`, or `resume` proposal has no
side effect without deterministic confirmation.

## Acceptance Criteria

The phase is complete when:

1. Enabling project mode imports the configured workspace and restores the last
   active workspace and Session after restart.
2. Voice can create a safe managed workspace only after host-verified
   confirmation.
3. Voice can list and select workspaces and Sessions without receiving paths or
   private IDs.
4. A normal run creates a new persistent Session; a confirmed resume restores
   the same real Codex thread across app-server processes and Orb restarts.
5. Workspace A and B use distinct persistent Codex homes and cannot resume one
   another's threads.
6. Switching projects never changes an accepted task's binding.
7. The provider sees only one additional function, `codex__project`.
8. Existing single-workspace, status, steer, progress, cancellation, redaction,
   desktop, and full repository tests remain green.
