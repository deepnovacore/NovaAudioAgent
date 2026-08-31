# Multi-project Workspace handoff

The realtime Codex project surface is always on. There is no project-mode toggle. This boundary does
not change ordinary non-realtime Codex: it retains `codex__run` and its existing semantics, while the
realtime provider does not expose `codex__run`.

## Workspace and Session boundary

A **Workspace** is one filesystem/Git project with its own Codex home. A **Session** is one durable,
resumable Codex thread inside exactly one Workspace. A Session never moves between Workspaces.

Nova stores managed Workspace directories under `~/.nova-audio-agent/workspaces`, registry state in
`~/.nova-audio-agent/codex-projects-v1.json`, and isolated Codex homes under
`~/.nova-audio-agent/codex-homes`. `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` optionally registers an
existing repository at startup; changing it later registers another canonical path without
replacing the current active Workspace.

## On-demand discovery and structured confirmation

Every realtime turn receives only the active Workspace and its active Session, if any. Nova lists
Workspace or Session candidates only when requested and never injects historical candidates into the
standing turn context. Public results contain speakable labels, not paths, thread IDs, registry keys,
or Codex-home locations.

Create, switch, and resume are proposals, not immediate mutations. The host binds the next user turn
to the proposal's epoch, item, and response. Only the dedicated confirmation function can commit it,
and its arguments must contain the exact proposal ID plus a JSON boolean. `false`, a mismatched or
missing ID, a non-boolean value, a stale response, or a replay fails closed without mutation.

While a proposal is pending, the desktop client renders it as a host-owned confirmation surface
rather than relying on how the model phrased the request: the orb names the exact operation, marks
it as not yet executed, shows the remaining time before automatic cancellation, and offers explicit
confirm and cancel controls. The surface is derived from host state, so a proposal the model
describes inaccurately still appears with its true operation and its true pending status.

## Staged flows

- Creating a Workspace is independent: propose it, confirm it, then start a new Session there with
  an optional title and work order.
- Switching first selects the Workspace. After that commit, list its Sessions on demand or start a
  new one.
- Resuming first selects the target Workspace when necessary, then proposes the Session resume as a
  separate confirmation.

Each accepted work order creates a persistent Session record before starting one app-server process.
Resume starts a new app-server process on the saved thread. Codex work remains globally serialized,
even though Workspace state and homes are isolated.

## Desktop maintenance

Voice can only create new managed directories. Everything else that touches a managed directory on
disk is a desktop action, confirmed in the host UI rather than through the model: the Settings panel
can open the active managed workspace, clear the active managed workspace, or clear every managed
workspace, and both clearing actions require two separate confirmation dialogs.

Clearing is a filesystem operation only. It empties the directory while the project record, display
name, Codex home history, and Session metadata survive in the registry, so a cleared Workspace stays
listable, switchable, and resumable rather than disappearing from the store.

## Recovery

One live Orb owns a registry at a time; another owner fails immediately with `state_busy`. On the
next clean acquisition, interrupted `starting` Sessions are recovered before new work is accepted.
Short metadata locks protect atomic registry updates but do not claim execution ownership.
