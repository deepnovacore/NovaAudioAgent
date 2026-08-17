# Codex Project Reliability Design

## Context

Phase 2 adds named Codex workspaces, persistent sessions, and deterministic voice
confirmation. Review of `feature/codex-multi-workspace` at `b3c4015` found a cluster of
failure-path defects: confirmed requests can lose their binding, persistent state can
become unrecoverable, and the realtime confirmation fence can discard protocol state.

This repair keeps the accepted product scope unchanged:

- Project mode remains opt-in.
- The provider still sees exactly four Codex tools.
- Only one Codex task may execute at a time.
- Workspace creation, selection, and session resume remain host-confirmed operations.
- No project path, workspace ID, thread ID, token, or confirmation nonce becomes public.

## Considered approaches

### 1. Surgical lifecycle repair with bounded state (selected)

Keep the current components and public tool contract, but remove the out-of-band armed
dictionary, bound persistent state, make lock acquisition non-blocking, and explicitly
close fenced provider tool calls. This limits the diff while repairing every reproduced
failure path.

### 2. Fully asynchronous registry service

Replace the file-backed store with a long-lived actor or database and make all callers
async. This would give stronger I/O isolation, but it is a new subsystem and is excessive
for a single-user local registry. It also expands Phase 2 beyond the accepted scope.

### 3. Minimal blocker-only patch

Strip `work_order`, pop `_armed`, catch startup errors, and clear the expiry set. This is
small, but leaves credential rotation, bounded persistence, realtime lock stalls, and
provider protocol closure unresolved. It would likely require another rescue pass.

## Confirmed run binding

Confirmed work will no longer use `ProjectCodexAdapter._armed` or a global dictionary.
`commit_confirmed` will place the immutable `ConfirmedProjectOperation` itself in the
host-created in-process `DelegateRequest` under a private key. Runtime delegate binding
uses shallow copies, so the exact Python object identity survives until adapter dispatch.
Provider-originated JSON cannot construct this type and the public schema still rejects
the private key.

The adapter accepts the private field only when its value is exactly a
`ConfirmedProjectOperation` whose normalized work order equals the normalized public
`work_order`. The object is consumed by that one dispatch; rejection, cancellation, or a
deadline leaves no adapter-side entry and therefore cannot poison later work.

All project request strings are normalized once at the parser boundary. Workspace and
session names use the store's NFKC/whitespace normalization, and `work_order` uses the
same stripping and length rule as ordinary `codex__run`.

## Session lifecycle and titles

New sessions are provisional until `on_thread_ready` proves a persistent thread exists.
If startup fails before that callback, the provisional record is rolled back rather than
retained as permanently unavailable.

For resumed sessions:

- credential, process, timeout, cancellation, and other transport failures preserve the
  existing `ready` record;
- a server rejection of `thread/resume`, missing history, thread-ID mismatch, workspace
  mismatch, or invalid persistent thread projection marks the record `unavailable`;
- the transport exposes a bounded `resume_unavailable` result code so the adapter can
  distinguish binding invalidity from transient transport failure.

Generated titles are voice-friendly, workspace-scoped ordinals: `任务 1`, `任务 2`, and
so on. They never derive from sensitive work-order content or Unix timestamps. Explicit
titles continue to receive deterministic suffixes on collision.

## Bounded registry and workspace import

The registry enforces these limits before writing:

- at most 100 workspaces;
- at most 200 sessions per workspace;
- at most 1000 sessions globally.

Before a new session is inserted, the store prunes the oldest unavailable sessions and
then the oldest inactive ready sessions. It never prunes a starting session or any
workspace's active session. If protected records alone exhaust a limit, the operation
fails with the bounded public code `session_limit` rather than growing into
`state_too_large`.

Changing `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` no longer conflicts with a non-empty registry.
`ensure_imported` registers a previously unseen trusted path and assigns a deterministic
unique display name (`name`, `name (2)`, ...). Existing paths remain idempotent, and an
existing active workspace is not silently replaced by startup import. Other
`ProjectStateError` failures are translated into bounded startup/configuration errors,
without private paths or tracebacks in normal CLI error handling.

Registry lock acquisition uses `LOCK_NB`. Contention returns `state_busy` immediately;
the realtime event loop never waits inside a blocking `flock`. JSON remains capped at
1 MiB and state writes remain atomic and owner-only.

## Credential refresh

Each persistent Codex home keeps an owner-only credential-source marker containing only
the SHA-256 digest last copied from the host credential file. On spawn:

1. Open and validate the host credential as a regular owner-controlled file.
2. If the destination is absent, atomically copy it with mode `0600` and record the digest.
3. If the host digest differs from the recorded source digest, atomically refresh the
   destination and marker.
4. If the host digest is unchanged, preserve the destination even when Codex refreshed it
   in place.

This propagates `codex login` and explicit host token rotation without overwriting a token
that was refreshed inside a persistent workspace. Copy and replacement never expose a
temporary `0644` file.

## Realtime confirmation protocol

Arming a confirmation response fence must pair with a receipt. If a host response is
already pending, `arm_next_response_fence` first marks its event IDs interrupted and
releases retained suggestion authority before the pending response is popped.

Every tool call blocked by a project-confirmation fence receives an immediate
`function_call_output` with a bounded `superseded`/`confirmation_reserved` result. The
output is injected without creating a continuation response and without entering the
runtime bridge, so it closes the provider call while preserving host-only authorization.
Deferred calls tied to the confirmation ASR item use the same closure path instead of
being deleted from the deque.

Confirmation expiry invalidates the proposal, closes any deferred calls, and reconnects
the provider session when an epoch-wide confirmation response fence remains. Reconnection
moves subsequent tools to a new epoch and rejects every late event from the old one. A
terminal event that arrives normally still clears only its exact response fence.

`ProjectConfirmationController.view` derives `pending_confirmation` from the expiry-aware
`pending` property so Orb state cannot display a stale proposal.

## Public UX and recovery

Internal error codes remain bounded and path-free, but realtime speech uses stable Chinese
messages rather than reading snake_case codes aloud. Invalid create proposals that can be
rejected without mutation are rejected before asking for confirmation.

The existing `workspace list` and `workspace register` commands remain. No delete command
is added in this repair; automatic retention keeps the state bounded, and adding a
destructive voice/CLI operation would expand authorization scope.

## Testing

Every repair begins with a regression test that fails on `b3c4015`:

- whitespace-confirmed work runs exactly once;
- a dropped, busy, cancelled, or deadline-bound confirmed delegate cannot poison later runs;
- host credential changes refresh atomically while destination-only refreshes survive;
- changing the imported workspace is idempotent and startup errors are bounded;
- generated titles are speakable and registry growth remains below all limits;
- transient resume failures stay ready while proven binding failures become unavailable;
- registry contention returns immediately without blocking the event loop;
- confirmation fencing emits interruption receipts and releases suggestion authority;
- blocked/deferred confirmation calls receive tool output without bridge dispatch;
- expiry recovers via a new provider epoch and clears stale Orb state.

Focused tests run after each red/green cycle. Completion requires Ruff, the complete Python
suite, Orb tests and build, package build, CLI smoke tests, a clean worktree, and an
independent review with no remaining Critical or Important findings.
