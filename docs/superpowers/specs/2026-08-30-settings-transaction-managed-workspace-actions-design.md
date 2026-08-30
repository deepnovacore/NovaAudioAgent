# Settings Transaction and Managed Workspace Actions Design

Date: 2026-08-30

Status: approved in chat for design documentation; implementation awaits review of this file

## Objective

Change the Ambient Orb Settings panel from per-control immediate persistence and backend restart to
an explicit draft-and-save transaction. Add host-owned actions to open the current Nova-managed
workspace, clear that workspace, and clear every registered Nova-managed workspace under the
configured managed root.

The design must preserve the realtime interaction loop, prevent renderer-controlled filesystem
targets, serialize backend lifecycle changes, and leave a safe authorization boundary for a future
voice plus function-call entry point. The future voice entry point is not part of this implementation.

## User-visible behavior

### Settings drafts

Changing a setting updates only the Settings window's local draft. It does not write the settings
file, notify the Orb of a new palette, refresh resolved configuration, or restart the backend.

The Settings footer contains a persistent `保存并重启` button. It is disabled when there are no
unsaved changes or while a save or workspace operation owns the lifecycle coordinator. Clicking it
submits one patch containing all public setting drafts plus the secret writes or clears currently
staged in password controls.

The panel may render its own selected values before saving, but no other process observes them.
Palette follows the same commit boundary as runtime settings: the Orb changes only after the save
commits. Operational buttons such as Codex rescan, microphone retry, directory repair, open, and
clear do not become setting drafts.

On success, Main persists the patch and performs exactly one controlled backend configuration
refresh and restart. The button and status area show `保存中`, `正在重启`, and the final connected or
failed state. A failed or partially rejected save retains the affected drafts. Edits made while a
save is in flight remain dirty for a later save and cannot be overwritten by the older response.

Secret plaintext remains write-only. It stays in DOM password inputs and the one outbound save
payload, never in controller public state, renderer snapshots, logs, or Main replies. Accepted
secret inputs are cleared only if their input revision still matches the submitted value.

Closing the Settings window discards unsaved drafts. This version does not add a close-warning or a
separate revert button.

### Managed workspace actions

The `Codex 与 Projects` section adds:

- `打开当前托管 workspace`
- `清空当前托管 workspace`
- `清空全部托管 workspaces`

`当前` means the active workspace in `CodexProjectStore`, not the editable `codexWorkspace` field
and not a renderer-provided path. The current actions are unavailable when the active workspace is
missing or has `origin=registered`. Imported directories, repositories outside the managed root,
and unknown managed-root children are never open or clear targets.

The all-workspaces action targets only store records with `origin=managed` whose canonical paths
are direct children of the resolved managed root. Unknown files or directories already present in
the managed root are left untouched.

Clear means removing filesystem contents while retaining each workspace record, display name,
active selection, and session metadata. It does not delete Codex project history or unregistered
managed-root entries. A later feature may offer a distinct project-history reset, but that is out
of scope.

## Architecture

### 1. Renderer draft controller

`settings-controller.mjs` owns three separate states:

- the last Main-confirmed public view;
- a public draft patch plus field-level dirty information;
- at most one submitted save batch, with any later edits retained as the next draft.

Control handlers call a staging operation instead of `api.set`. The staging operation merges nested
maps such as provider-specific LLM models without mutating the confirmed view. A single explicit
`save` operation snapshots the current public draft, accepts a write-only secret patch supplied by
`settings.mjs`, and calls `api.set` once.

Main pushes continue to update live fields such as backend and microphone status. They must not
replace staged values. A save reply clears only fields whose submitted values were accepted and
which have not changed since submission.

The renderer exposes dirty and busy state to `settings.mjs` so the footer button, status text, and
workspace buttons remain deterministic. It does not decide filesystem paths or deletion scope.

### 2. Main lifecycle coordinator

Main owns one async coordinator for operations that can stop, refresh, or restart the backend.
Settings apply, Codex rescan when it requires restart, current-workspace clear, and all-workspaces
clear must acquire this coordinator. Renderer button disabling is advisory; Main rejects or queues
conflicting IPC independently.

The explicit settings save keeps the existing durable ordering:

1. validate and persist through the serialized settings writer;
2. update the committed public settings view;
3. notify the Orb of committed live-facing settings;
4. resolve desktop configuration from the committed settings;
5. perform one backend restart;
6. publish the final apply state.

If persistence fails, no refresh or restart occurs. If configuration refresh fails, the saved file
remains the durable configuration, the previous running backend is not stopped, and the panel
reports that the new configuration was not applied. If restart fails after the old backend stops,
the failure is explicit and the existing retry action remains available.

### 3. Host-owned workspace maintenance service

A new runtime desktop maintenance surface uses `CodexProjectStore` and the packaged native project
authority. It is callable by trusted host code, not directly by the renderer. It accepts symbolic
scope (`current_managed` or `all_managed`) rather than paths.

The service has two phases:

1. `prepare` opens a bounded store transaction, resolves the exact registered targets, verifies
   managed origin, direct-child containment, canonical path, root identity, and workspace identity,
   and returns a short-lived opaque preparation plus a public preview containing only names/counts.
2. `execute` consumes that preparation once, revalidates the store revision and identities, and
   requires a host-minted authorization bound to that exact preparation.

The opaque preparation and authorization are non-serializable host objects. Renderer IPC can ask
Main to begin an action, but it cannot supply a path, workspace ID, preparation token, or
authorization object.

Opening the current workspace uses the same resolver and then calls Electron `shell.openPath` on
the host-resolved canonical path. It is read-only and does not stop the backend.

Clearing requires the backend to be stopped cleanly before `execute` opens the store for
maintenance. Failure to stop aborts before any filesystem mutation. Main restarts the backend after
success and also attempts recovery after a failed clear.

### 4. Atomic clear operation

Each target workspace is replaced atomically within the retained managed root:

1. revalidate that the registered workspace is the exact direct child recorded by the store;
2. rename it descriptor-relatively to a service-generated tombstone name;
3. create and protect a new private directory at the original basename;
4. verify the new root and update the maintenance store's pinned identity;
5. recursively remove the detached tombstone without following symlinks or reparse points.

The original canonical path and project record remain stable while the content becomes empty. A
failure before replacement commits rolls the rename back. A failure after replacement but before
tombstone cleanup is reported as a partial failure and never as successful clearing; the generated
tombstone remains a bounded, recognizable cleanup target for a later retry. The service never
falls back to deleting an unresolved path.

The all-workspaces action prepares and revalidates the complete target set before changing any
workspace. It first renames the complete set to tombstones, then creates and validates the complete
replacement set. Any failure before every replacement is valid removes the new empty roots and
renames every tombstone back. Only then does the operation cross its commit point and begin
tombstone cleanup. It never expands to newly appearing children.

### 5. Double confirmation

Both clear commands use two native Electron dialogs owned by Main:

1. the first dialog shows the resolved workspace name or managed workspace count and explains that
   active backend work must stop;
2. the second dialog identifies the action as irreversible and uses an explicit destructive button
   label (`永久清空当前 workspace` or `永久清空全部托管 workspaces`).

Canceling either dialog consumes the preparation and causes no backend stop or filesystem change.
Only after the second confirmation does Main acquire the lifecycle coordinator, revalidate the
same prepared target set, mint its one-shot authorization, and stop the backend. A changed or
expired preparation aborts and requires a new confirmation cycle; Main never substitutes a newly
resolved target behind an already accepted dialog.

## Future voice and function-call integration

The maintenance service is entry-point neutral. Settings IPC is the first caller, not the authority
model.

A future voice tool must use a proposal-and-commit flow:

1. a tool call may request a clear proposal for symbolic scope, producing a proposal ID and the
   same bounded preview used by Settings;
2. the proposal binds scope, exact workspace IDs and identities, causal user item/origin reference,
   provider response ID, expiry, and preparation revision;
3. spoken or clicked confirmation must commit that exact proposal through the existing host
   confirmation controller;
4. commit may reconstruct a fresh preparation only when the exact target IDs, identities, scope,
   and store revision still match the proposal;
5. only the committed same-proposal confirmation may mint the one-shot host authorization used by
   `execute`;
6. direct clear tool calls, transcript text, stale confirmations, mismatched response IDs, changed
   target sets, and replayed authorizations are rejected.

No voice tool schema, provider prompt, or confirmation UI for this future path is added now. The
current work only prevents the Settings implementation from baking renderer IPC or raw paths into
the core deletion API.

## IPC and status boundary

Preload exposes narrow operations for `save`, `openCurrentManagedWorkspace`,
`clearCurrentManagedWorkspace`, and `clearAllManagedWorkspaces`. Clear requests carry no target
data. Main validates that the sender is the live Settings window for every request.

Replies use bounded status codes and public names/counts only. They never expose state-file paths,
workspace identities, tombstone names, native errors, or secret values. Expected outcomes include
`opened`, `cleared`, `cancelled`, `not_managed`, `empty`, `busy`, `stop_failed`, `clear_failed`, and
`restart_failed`.

Settings view data may include a bounded capability summary such as whether an active managed
workspace exists and its public display name. It must not use editable renderer state to calculate
button eligibility.

## Error handling

- No save change reaches Main before the explicit save action.
- No clear mutation occurs before both confirmations and a clean backend stop.
- An imported or out-of-bound workspace fails closed.
- A stale prepared target fails closed and requires a new confirmation cycle.
- A settings or workspace operation cannot overlap another backend lifecycle operation.
- Backend recovery is attempted after any post-stop clear outcome.
- Partial tombstone cleanup is visible as failure and can be retried; it is never hidden as success.
- Renderer closure does not cancel an already confirmed host operation, but it cannot authorize a
  new one.

## Testing strategy

### Renderer/controller

- Changing every public control stages state without calling IPC.
- One save submits one merged patch and produces one restart lifecycle.
- Nested provider model drafts merge correctly.
- Main pushes update live status without overwriting drafts.
- Edits made during an in-flight save remain dirty.
- Rejected or failed fields remain dirty; accepted unchanged fields clear.
- Secret plaintext never enters render snapshots or public controller state.
- Secret input revisions protect newer typing from an older save response.
- Save and workspace buttons expose correct dirty/busy/eligibility states.

### Main/preload

- IPC rejects non-Settings senders and any request carrying target data.
- Settings persistence failure causes zero restarts.
- One successful save causes exactly one refresh and restart.
- Either confirmation cancellation causes zero stops and zero mutations.
- Backend stop occurs only after the second confirmation.
- Clear success and failure both exercise bounded backend recovery.
- Lifecycle operations cannot overlap.
- `shell.openPath` receives only the host-resolved current managed path.

### Runtime maintenance

- Current managed resolution succeeds; registered/imported active workspaces fail closed.
- All scope selects only registered managed records and preserves unknown root children.
- Canonical containment, direct-child, identity, symlink, and reparse substitutions fail closed.
- Atomic replacement produces an empty private directory at the original path.
- Pre-commit failures restore the original directory.
- Post-commit cleanup failures report partial failure without targeting unrelated entries.
- Store records, active selection, and session metadata remain unchanged.
- Preparations expire, become stale on revision/identity changes, and are single-use.
- Authorization is exact-target, single-use, and cannot be constructed from serialized input.

### Regression verification

Run runtime build/tests, desktop build/tests, and repository checks serially because both suites
mutate `runtime/dist`. Preserve and integrate with the existing uncommitted proxy/search work rather
than overwriting it. Exercise a real Settings-window smoke where the environment permits Electron:
changing settings must not disconnect voice until Save, Save must reconnect once, open must reveal
the exact managed directory, and both clear actions must visibly honor both confirmations.

## Non-goals

- No voice/function-call deletion tool in this change.
- No clearing of imported or arbitrary workspaces.
- No deletion of project records, Codex histories, or session metadata.
- No user-entered filesystem path in a clear request.
- No automatic save, save-on-close, or immediate palette application.
- No change to the realtime voice WebSocket or core interaction loop.
