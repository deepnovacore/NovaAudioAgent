# Multi-project Workspace handoff

Realtime Codex project mode is always on. There is no project-mode toggle.

## Workspace and Session boundary

A **Workspace** is one filesystem/Git project with its own Codex home. A **Session** is one durable,
resumable Codex thread inside exactly one Workspace. A Session never moves between Workspaces.

Nova stores managed Workspace directories under `~/.nova-audio-agent/workspaces`, registry state in
`~/.nova-audio-agent/codex-projects-v1.json`, and isolated Codex homes under
`~/.nova-audio-agent/codex-homes`. `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` optionally registers an
existing repository at startup; changing it later registers another canonical path without
replacing the current active Workspace.

## On-demand discovery and structured confirmation

Nova lists Workspace or Session candidates only when requested. It does not inject the full
historical registry into every realtime turn. Public results contain speakable labels, not paths,
thread IDs, registry keys, or Codex-home locations.

Create, switch, and resume are proposals, not immediate mutations. The host binds the next user turn
to the proposal's epoch, item, and response. Only the dedicated confirmation function can commit it,
and its arguments must contain the exact proposal ID plus a JSON boolean. `false`, a mismatched or
missing ID, a non-boolean value, a stale response, or a replay fails closed without mutation.

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

## Recovery

One live Orb owns a registry at a time; another owner fails immediately with `state_busy`. On the
next clean acquisition, interrupted `starting` Sessions are recovered before new work is accepted.
Short metadata locks protect atomic registry updates but do not claim execution ownership.
