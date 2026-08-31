<!-- Keep in sync with README.zh-CN.md -->

# Nova Audio Agent

**An always-on, one-for-all voice agent with restrained proactivity.**

**English** | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-Control%20Plane-7B2CBF.svg)](#2-architecture)
[![Blog](https://img.shields.io/badge/Blog-Tradeoff%20Ruler-0B7285.svg)](docs/blog/2026-08-proactive-voice-agent-design-space.md)

Nova Audio Agent is a **harness for an always-on, general-purpose voice agent**: Nova (小诺)
keeps the conversation responsive while independent capabilities search, observe, operate
devices, or complete longer tasks in the background.

It is not a chatbot framework or a workflow engine: it studies **when an agent should speak,
dispatch work, or stay silent while several things happen at once**, giving each component
exactly one judgment ([Glossary and invariants](docs/glossary.md)). Nova is user-level rather
than per-project (§4), and experimental rather than turnkey.

A most relevant recent work is [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) ([NOTICE](NOTICE)): it answers
*how to keep an agent talking while it works*; we ask the mirror question — when is talking
worth it at all ([design post](docs/blog/2026-08-proactive-voice-agent-design-space.md)).


**New here?** Read [Design essence](docs/essence.md), or jump to [Quickstart](#3-quickstart).

https://github.com/user-attachments/assets/94f4f199-ab5e-4c26-aef5-efb00cfe8bc0

## 1. Highlights

- **Milestones get reported.** Every capability writes its own append-only channel, and a result
  reaches canonical memory before it can reach the conversation; long Codex work checks in on a
  fixed cadence. A busy moment delays the telling, never the record.
- **Not every word is worth saying.** `speak=false` is silence, not forgetting: a deferred
  observation waits in the suggestion pool, re-arms only when new evidence lands on the channel
  it cited, and `memory.recall` still answers from that same state.
- **Important words take over.** Search, Camera, Watch, Guard, and Codex sit behind one arbiter,
  and priority is bound to the triggering event, never chosen by the model — user 100, Guard 90,
  active executors 50, ambient 40. A Guard hit cuts Nova's own sentence short mid-utterance; it
  never cuts off yours.
- **Your voice assistant for workspace management.** One entry point across every named
  workspace: isolated Codex homes, resumable Sessions, fail-closed propose-and-confirm on every
  create, switch, and resume.
- **Token discipline and live steering.** Codex receives one bounded work order, never
  conversation history, and a new user constraint joins the in-flight `codex app-server` turn
  instead of restarting it (§2). Clarifying before dispatch also beats paying for a wrong run:
  on an internal task set it cut Codex-side tokens by roughly 31% (internal measurement, no
  reproduction script ships here).

## 2. Architecture

[![Nova Audio Agent runtime architecture on a chalkboard](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

*One event loop, two model ports reading one ContextView, Memory as the shared blackboard,
Floor guarding the single speech path.*

Non-negotiable boundaries, checked at the runtime boundary rather than promised in prompts
([Architecture](docs/architecture.md)):

1. The runtime dispatches executor work without waiting for it in the event-loop body.
2. Every accepted result reaches canonical memory first; executors never speak to the user.
3. Only FastBrain updates structured intent, goal, and authorization.
4. Only manifests selected by configuration become model-facing tools.
5. Unsolicited suggestions pass `Surrogate → Floor → FastBrain`; deferred utterances land in
   the suggestion pool instead of being dropped.

Progress is a memory problem before it is a notification problem — **publish once, decide
later, answer from the same state** — separating three judgments that are easy to conflate:

| Question | Owner |
|---|---|
| What happened? | Executor → canonical Memory |
| Nobody asked: is this change worth saying now? | Surrogate, for eligible ambient suggestions |
| The user asked: how should the answer be expressed? | FastBrain over a bounded `ContextView` |

The front brain owns the conversation; Codex is the slow work brain behind a narrow boundary:

- one bounded work order crosses to Codex — never conversation history;
- progress returns summarized at the Codex projection boundary, filtered by Surrogate;
- the conversation channel compresses at a fixed watermark; `codex__steer` appends to the
  in-flight turn instead of re-dispatching;
- workspace-graph context enters model calls only through fixed budgets.

## 3. Quickstart

Requirements: Node.js 22+, npm, Git, a logged-in `codex` executable (app-server is the only
Codex transport), and a supported desktop session; native helpers need one platform toolchain
([Getting started](docs/getting-started.md)). Validation is uneven:

- Native echo-cancelled capture (VoiceProcessingIO) is macOS-only; Windows and Linux use
  Chromium's audio stack.
- CI validates source builds on macOS, Windows, and Ubuntu. Ubuntu is source-only: install the
  dependencies, configure `.env`, then launch it yourself with `npm run start:client`.
- Tagged releases publish an unsigned, versioned Windows installer only after its installed-smoke
  test passes; hardware validation and signed packages remain pending
  ([Project status](docs/status.md)).

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
```

Set `DASHSCOPE_API_KEY` and `TAVILY_API_KEY` for the default integrated Qwen desktop — Search
is always assembled, so Tavily is required even when not selected as an executor.

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

`diagnose` never contacts providers or opens devices. Nova is Chinese-first (persona, prompts,
default voice); per-integration setup and variables: [Getting started](docs/getting-started.md).

## 4. One assistant, many workspaces

A **Workspace** is an isolated filesystem/Git project with its own `CODEX_HOME`; a **Session**
is a Codex thread inside one that suspends and resumes at any time.

Every lifecycle action — create, switch, resume — takes two steps: voice produces a proposal,
and only a structured confirmation carrying that proposal's ID commits it; rejection, a
mismatched ID, or a replay fails closed. Codex execution is globally serialized, and the desktop
client surfaces public labels only. Voice creates new managed directories only; connecting an
existing repository goes through `NOVA_AUDIO_AGENT_CODEX_WORKSPACE`. Nova Desktop can also open
the active managed workspace, or clear one or all of them behind two confirmations — clearing
empties the directory while the project record, display name, Codex history, and Session
metadata survive. Full contract:
[Multi-project Workspace handoff](docs/multi-project-workspace-handoff.md); retention and
credentials: [Getting started](docs/getting-started.md).

Two memory layers sit on top. An opt-in workspace graph records weak `discussed_with` cues —
bounded, low-authority, below the proactive threshold, stale after 90 days — and Nova never
reads another workspace on its own ([v3 memory volume](docs/archs/v3/02-memory.md)). The
optional MyContext boundary adds a person-wide evidence source: read-only, untrusted, never
proactive, consulted only for explicit recall. No Nova-compatible read-only adapter ships here,
so that path is not functional end to end, and upstream MyContext (Elastic License 2.0) needs a
separate legal and distribution review before reuse or bundling.

```bash
NOVA_AUDIO_AGENT_CODEX_WORKSPACE=/absolute/path/to/initial/repository
NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED=true
NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL=http://127.0.0.1:PORT/base
```

## 5. Nova Desktop

Nova Desktop is the local voice interface. After filling `.env`:

```bash
npm run start:client
```

The launcher starts the Node runtime and a sandboxed, context-isolated Electron renderer; it
needs the `codex` executable, microphone permission, and `TAVILY_API_KEY`. `DASHSCOPE_API_KEY`
is needed only for integrated Qwen and cascaded Qwen, and cascaded Ark needs `ARK_API_KEY`
plus `DOUBAO_BIGMODEL_API_KEY`. Pipeline shapes, key reuse, and settings behavior:
[Getting started](docs/getting-started.md).

The orb is a Canvas 2D particle field whose behavior carries state — converging while
listening, pulsing with playback, an orbiting band while Codex works — in the Ember or
Graphite palette. When a project action waits on you, it becomes a host-owned confirmation card
that names the exact operation, marks it as not yet executed, and counts down to automatic
cancellation.

Right-clicking opens the Memory Board and a settings panel covering palette, proactivity, Codex
cadence, voice, pipeline shape, Codex executable discovery, the managed workspace root, and the
§4 workspace actions. Edits stay in that window as drafts until the save-and-restart button
(labelled `保存并重启`, since the interface is Chinese-first) writes them, refreshes resolved
configuration, and performs exactly one controlled backend restart; the palette commits on that
same boundary. API keys are write-only, encrypted via the OS keychain, and read back as
presence only.

## 6. FAQ

### Windows reports `project_directory_open_failed_home`

This is usually not an npm, build, or Electron failure. Nova opens `%USERPROFILE%` at startup and
fails closed when that directory's owner SID differs from the current process user's SID (the
check is in [`project_native_windows.c`](desktop/ambient-orb/native/project-native/project_native_windows.c#L707);
its caller is [`project-directories.mjs`](desktop/ambient-orb/src/main/project-directories.mjs#L78)). In PowerShell:

```powershell
icacls.exe "$env:USERPROFILE" /setowner "$env:USERDOMAIN\$env:USERNAME" /Q
(Get-Acl "$env:USERPROFILE").Owner
```

If `icacls` reports insufficient permission, use an Administrator PowerShell. The second command
should print the current computer/domain and username; then retry `npm run start:client`. Do not
add `/T`: Nova only checks the home directory itself. Diagnosis is read-only; the repair changes
only that directory's owner and does not recurse.

## 7. Documentation

| Read this | For |
|---|---|
| [Design essence](docs/essence.md) | Stance and non-goals |
| [Architecture](docs/architecture.md) | Modules and boundaries |
| [Glossary and invariants](docs/glossary.md) | Vocabulary and rules |
| [Getting started](docs/getting-started.md) | Setup and integrations |
| [Project status](docs/status.md) | What works, what's experimental |
| [Multi-project Workspace handoff](docs/multi-project-workspace-handoff.md) | The complete Workspace/Session contract |
| [A2A](docs/a2a.md) | Agent-to-agent boundaries |
| [v3 design series](docs/archs/v3/00-overview.md) | The detailed design argument |
| [A Tradeoff Ruler for Proactive Voice Agents](docs/blog/2026-08-proactive-voice-agent-design-space.md) | The design-space essay |

## 8. Roadmap

- [ ] **The cascaded pipeline as the cheaper default** — the cascaded topology is already
  selectable (Volcengine ASR, `qwen-flash`, Volcengine TTS), but costing less than integrated
  `qwen-audio-3.0-realtime-plus` is an expectation rather than a measurement; live validation
  and a cost comparison come before recommending it over the integrated default.
- [ ] **MyContext end to end** — a Nova-compatible read-only adapter, after the Elastic
  License 2.0 review; only the strict client boundary ships today.
- [ ] **Workspace graph on by default, plus episodic memory** — once soak evidence justifies
  it; today the graph is opt-in and session-level episodic summaries are unbuilt.
- [ ] **More coding agents through the executor port** — the `ExecutorAdapter` port is the
  seam for ACP or native protocols; Codex is the only backend today.

## 9. Development and verification

```bash
npm ci && npm run check && npm run build && npm test
```

Live integrations are credential- and hardware-dependent and never substitute for the
deterministic tests. Security reports: [SECURITY.md](SECURITY.md); contribution rules and
invariants: [CONTRIBUTING.md](CONTRIBUTING.md).

## 10. License

Copyright 2026 DeepNovaCore, [Apache License 2.0](LICENSE). Third-party attribution:
[NOTICE](NOTICE) and [desktop notices](desktop/ambient-orb/THIRD_PARTY_NOTICES.md).
