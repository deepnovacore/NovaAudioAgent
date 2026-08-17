# Codex Clarification and Workspace Isolation Design

Date: 2026-08-17

## Problem

Nova Audio Agent currently has two independent sources of task interference.

First, the realtime frontend instructions use “web page or desktop program” as
the sole example of a material clarification. A speech model can copy that
example as a preferred question even when delivery form is not the real
uncertainty.

Second, the Ambient Orb resolves one `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` at
process startup and builds one Codex executor for it. The live app-server
transport also reuses one Codex thread for as many as 16 clean turns. Distinct
work orders can therefore share both a filesystem root and model history.

The immediate correction and the longer-term multi-workspace architecture must
be compatible, but they should not be delivered as one risky rewrite.

## Goals

1. Remove the delivery-form bias from clarification behavior without removing
   the useful one-question clarification rule.
2. Prevent independent Codex work orders from inheriting one another's Codex
   thread history.
3. Define a safe architecture for multiple persistent project workspaces and
   voice-created workspaces.
4. Preserve current authorization, workspace validation, progress, steering,
   status, redaction, and result-delivery boundaries.
5. Keep raw paths, Codex thread IDs, and routing metadata out of user-facing
   speech.

## Non-goals

- Voice deletion or relocation of workspaces.
- Allowing speech to grant access to an arbitrary absolute path.
- Migrating a running task after its workspace has been selected.
- Running concurrent Codex tasks in the first implementation phase.
- Replacing the current realtime provider or Runtime event model.
- Copying qwen-audio-agent's ACP implementation verbatim.

## Reference Architecture

The qwen-audio-agent reference separates one persistent coordinator Session
from independent project Sessions. The realtime frontend submits an objective
but does not list, create, resume, or cancel backend Sessions itself. A
persistent registry records project Session identity, working directory, and
title. Project work is delegated asynchronously and correlated back to its
originating request.

Nova should adopt the same boundary rather than merely adding a `workspace`
string to `codex__run`. Nova's existing executor and event contracts remain the
outer architecture; the coordinator and project-session manager sit behind a
generic project-work boundary.

## Phase 1: Clarification Correction

`FRONTEND_INSTRUCTIONS` will describe the decision rule without naming a
specific artifact type:

- Ask at most one short question only when a missing choice would materially
  change the accepted result or validation method and cannot be safely inferred
  from the request or current conversation.
- Do not ask about preferences that have a reasonable default.
- If the objective and acceptance boundary are sufficient, submit the complete
  work order immediately.
- After an answer, merge the original request and clarification into one work
  order.

The instructions must not contain “web page or desktop program” or an
equivalent preferred pair. This is a prompt invariant, not a new heuristic in
the host. The realtime model remains responsible for natural-language
clarification while the host remains responsible for authorization and task
lifecycle.

### Verification

- A focused prompt test asserts the generic material-choice rule.
- A regression test asserts that the old delivery-form pair is absent.
- Existing work-order preservation and one-question tests continue to pass.

## Phase 1: Codex Thread Isolation

Every accepted independent `codex.run` work order starts on a fresh Codex
thread. A completed turn is not retained as the starting context for the next
work order, even when both work orders use the same filesystem workspace.

`codex.steer` remains attached only to the active turn. It does not create a
follow-up turn and cannot steer a completed or superseded task.

Continuity is carried in the complete work order assembled by the realtime
frontend and Nova's bounded conversation context, not by implicit reuse of a
private Codex thread. This makes isolation the default and prevents unrelated
requests from sharing hidden history.

The app-server process may later be pooled as an optimization, but a process
reuse optimization must not imply thread reuse. The initial implementation may
tear down and re-establish the warm transport after every completed work order
if that is the smallest safe change.

### Failure behavior

- Failure, cancellation, timeout, or malformed completion already recycles the
  live transport and will continue to do so.
- Failure to establish a fresh thread returns the existing bounded refusal or
  uncertain result; it never falls back to the previous thread.
- Status continues to describe only the active or most recent work order.

### Verification

- A failing regression test first demonstrates that two clean runs currently
  target the same thread.
- After the change, two clean runs must use distinct thread IDs.
- Steering during a run must target that run's active thread and turn.
- Steering after completion must remain rejected.
- Prewarm, cancellation, progress, redaction, and teardown tests must remain
  green.

## Phase 2: Host-owned Workspace Registry

Multi-workspace support introduces a persistent `WorkspaceRegistry` owned by
the host. User-visible project identity is a stable opaque `workspace_id` plus
a display name. Canonical filesystem paths are private host data.

Each record contains:

```text
workspace_id
display_name
canonical_path
origin = managed | registered
created_at
last_used_at
```

The registry is stored with owner-only permissions using write-then-rename
replacement. On every use, the host resolves the canonical path, verifies that
it is an existing directory, and re-applies the current Codex preflight and
sandbox checks.

Two origins are supported:

- `managed`: created by Nova as a direct child of one configured managed root.
- `registered`: an existing directory explicitly registered outside the voice
  flow through trusted configuration or a future settings UI.

Speech never supplies or authorizes an arbitrary absolute path.

## Phase 2: Project Sessions and Routing

A workspace is a filesystem and authorization boundary. A project Session is a
model-history boundary. They are not the same object: one workspace may contain
multiple independent Sessions.

The routing model is:

```text
realtime frontend
  -> submit project objective
  -> persistent coordinator context
  -> WorkspaceRegistry + ProjectSessionRegistry
  -> start a fresh Session or continue an explicitly selected Session
  -> bind task_id to workspace_id and session_id
  -> deliver progress and final result through the existing Runtime
```

The coordinator may continue an existing project Session only when the current
request explicitly refers to prior work or the conversation contains an
unambiguous task reference. Sharing the same workspace is not sufficient reason
to reuse a Session. A new independent request in the active workspace starts a
fresh Session.

Every accepted task stores an immutable binding:

```text
task_id -> workspace_id + session_id
```

Changing the active workspace affects only future tasks. It never migrates,
retargets, cancels, or changes status routing for an existing task.

The realtime frontend may speak user-visible project names, but it does not see
canonical paths, Codex thread IDs, delegation IDs, or session IDs. Status and
cancellation use task correlation already owned by the host.

## Phase 3: Voice Workspace Creation

Voice creation is a user-visible project operation, not arbitrary filesystem
access. A request such as “create a project called Weather Board and build a
dashboard in it” is submitted as one objective. The coordinator asks the host
to create the logical workspace, then starts the first project Session in it.

Creation rules:

1. Use only the configured managed root.
2. Normalize the spoken display name into a bounded safe slug.
3. Reject empty names, traversal, path separators, reserved names, symlink
   escapes, and collisions; do not silently select an existing directory.
4. Create only one direct child directory and atomically add its registry
   record.
5. If directory creation succeeds but registry persistence fails, remove the
   newly created empty directory; never remove a non-empty directory.
6. If creation succeeds but the first task fails, retain the workspace and
   report the task failure. The user's project is not rolled back.
7. Do not provide voice deletion in this design.

Existing repositories are registered through configuration or a trusted UI so
that speech recognition cannot accidentally grant access to the wrong path.

## Components

### Realtime instructions

Own natural clarification and complete-objective formation. They do not own
filesystem or Session routing.

### WorkspaceRegistry

Own logical project metadata, safe managed-directory creation, canonical-path
validation, persistence, and lookup by opaque ID or display name.

### ProjectSessionRegistry

Own the mapping between user-visible projects and backend-private Codex Session
identities. Multiple Sessions may point at one workspace. Session records are
never spoken or placed in frontend tool results.

### Project coordinator

Own the decision to create a new project Session or continue an existing one.
It receives the natural objective and bounded conversation references, not a
frontend-authored execution plan. Its backend tools use logical workspace IDs
and never trust model-supplied canonical paths.

### Codex session manager

Own one active turn per project Session, workspace-specific transport creation,
preflight, steering, status, cleanup, and bounded pooling. Its public results
reuse the existing Codex handoff and progress contracts.

## Compatibility and Migration

During Phase 1, `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` remains required and behaves
as the single configured workspace. Thread isolation changes hidden context but
does not change the tool schema or user-visible startup flow.

When Phase 2 is enabled, the configured workspace is imported as the initial
registered workspace. Existing deployments therefore start with one project
and can add more without losing their current configuration.

Registry and coordinator features should be guarded by explicit settings until
their migration and recovery tests pass. Disabling them returns to the single
configured workspace while preserving registry data on disk.

## Security Invariants

- A model-produced name is data, never a filesystem path.
- Workspace lookup returns only pre-registered canonical paths.
- Every Codex transport is constructed with exactly one validated workspace.
- A task cannot change workspace or Session after acceptance.
- Independent tasks never share a Codex thread implicitly.
- Paths, credentials, work orders, thread IDs, and Session IDs remain subject
  to existing redaction and frontend-projection rules.
- Registry files use owner-only permissions and atomic replacement.
- No voice operation deletes, moves, or registers an arbitrary existing path.

## Implementation Sequence

1. Add clarification prompt regression tests and update the prompt.
2. Add a red test for cross-work-order thread reuse.
3. Change the live app-server lifecycle so each independent run starts a fresh
   thread; retain same-turn steering.
4. Run focused Qwen, Codex live, app-server, assembly, and desktop tests, then
   the full suite required by the repository.
5. Design the persistent registry schemas as a separate implementation plan.
6. Add WorkspaceRegistry and migrate the configured workspace.
7. Add ProjectSessionRegistry, coordinator routing, task bindings, and
   task-specific status/cancellation.
8. Add safe managed workspace creation and its voice behavior.

Phases 2 and 3 require their own implementation review because they add durable
state and broaden the set of filesystem mutations. Phase 1 can ship
independently and provides immediate isolation value.

## Acceptance Criteria

Phase 1 is complete when:

- The realtime prompt no longer contains the fixed web-versus-desktop example.
- The generic clarification and complete-work-order invariants are covered by
  tests.
- Two successful independent Codex runs never use the same thread.
- Same-turn steering still works and post-completion steering is rejected.
- Focused and repository-required verification passes.

The multi-workspace architecture is ready for implementation when:

- A persisted registry can represent managed and registered workspaces without
  exposing paths to the frontend.
- A task is immutably correlated to one workspace and one project Session.
- New independent work and explicit continuation have distinct tested routing
  behavior.
- Voice creation can create only a safe direct child of the managed root.
- Switching the active workspace affects only future tasks.
