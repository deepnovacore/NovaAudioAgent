<!-- Keep in sync with README.zh-CN.md -->

# Nova Audio Agent

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-ControlPlane-7B2CBF.svg)](#4-architecture)
[![Blog](https://img.shields.io/badge/Blog-Design-0B7285.svg)](docs/en/blog/2026-08-proactive-voice-agent-design-space.md)


> **A personal agent that understands your context, keeps work moving through conversation, checks results, and speaks when it matters.**


## News

- **2026-10-07 · [v0.3.0](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.3.0)** — A personal Workbench, source-backed memory and tasks with acceptance criteria. Realtime and cascaded voice support Qwen, OpenAI, Gemini, Volcengine and self-hosted services; availability depends on the selected pipeline.

<details>
<summary>Earlier releases</summary>

- **2026-09-24 · [v0.2.3](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.3)** — Guided first run: one DashScope API Key is enough to start talking.
- **2026-09-21 · [v0.2.2](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.2)** — Ubuntu 22.04+ x64 desktop, plus the headless `nova-audio-agent-server` with QR pairing.
- **2026-09-21 · [v0.2.0](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.0)** — Configurable ASR / LLM / TTS pipelines, personal memory, custom MCP, wake words, bilingual desktop on macOS and Windows, and an iPhone client over Tailscale.
- **2026-08-31 · v0.1.0** — Always-on voice, background Codex tasks, live steering, workspace/session management, and selective progress updates.

</details>

## 1. Highlights

Nova brings conversation, your authorized context and background execution into one personal agent. Talk through a goal, organize your todos, ideas and goals on the Workbench, and follow the work through to an evidence-backed result.

- **Voice and text, together.** Keep talking while work runs; clarify a request or change direction without starting over.
- **Conversation beside your tasks.** Todos, Ideas, Goals, Feeds, Tasks and Profile sit beside the conversation. Switch to the orb or let tasks run in background mode with the microphone off.
- **Context from your own sources.** Connect folders, mail, calendars and Feishu. Source access and permission for the configured model to process content are separate choices.
- **Memory with sources.** See what Nova has learned, trace it to its evidence, correct it, forget it or purge it. Imported document knowledge remains a separate searchable corpus.
- **Tasks you can check.** Clarify goals, confirm workspaces and sessions, then delegate to Codex. Refine the work as it runs; Nova checks evidence against acceptance criteria, and you can take over and return control.
- **Thoughtfully proactive.** Meaningful progress, camera events and optional daily briefs get your attention at an appropriate moment. Routine updates stay quiet; reminders respect your speaking turn.

Learn more about [source permissions](docs/en/sources-and-connectors.md), [task controls](docs/en/tasks.md) and [when a voice agent should speak](docs/en/blog/2026-08-proactive-voice-agent-design-space.md).

## 2. Work with Nova

### Your workbench and context

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Your personal workbench</h3>
      <p>Todos, Ideas, Goals, Feeds, Tasks and Profile sit beside your conversation with Nova. Switch to the voice orb, or hide the window and turn off the microphone while tasks keep running.</p>
      <img src="assets/features/workbench-window.png" alt="Workbench window with todos on the left and the conversation with Nova on the right" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Profile and personal memory</h3>
      <p>See what Nova knows about you, each entry marked as something you said or something from your sources. Continue, correct, forget or purge any of it.</p>
      <img src="assets/features/profile-memory.en.png" alt="Profile overview and personal memory controls" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Todos and project recaps</h3>
      <p>Recent project activity becomes recap cards and suggested next steps, each with its sources. Pick one and ask Nova to help.</p>
      <img src="assets/features/workbench.en.png" alt="Workbench project recaps and next-step suggestions" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Ideas and goals</h3>
      <p>Jot down ideas and set goals. Review source-grounded suggestions before adopting them.</p>
      <img src="assets/features/ideas-goals.png" alt="Ideas and Goals pages with suggestions from Nova" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Feeds ranked by your interests</h3>
      <p>Nova infers your interests from your Profile and ranks public news by them. Save an item, or turn it into an idea, todo or goal of your own.</p>
      <img src="assets/features/feeds.png" alt="Interest-ranked news feed" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Bring your tools and knowledge</h3>
      <p>Configure ASR / LLM / TTS and MCP; ask questions across your documents.</p>
      <img src="assets/features/knowledge.en.png" alt="Knowledge-base answer using the CN-27 demo documents" width="100%">
    </td>
  </tr>
</table>

### Delegate and steer work

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Understands what you mean</h3>
      <p>Describe your goal naturally. Nova asks for the missing details before turning it into a task.</p>
      <img src="assets/features/conversation.en.png" alt="Nova clarifies the requested application before starting" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Voice Vibe Coding</h3>
      <p>Clarify a goal, let Codex work in the background, and refine it by voice or text. Nova checks task evidence against acceptance criteria; take over and hand it back at any time.</p>
      <img src="assets/features/coding.en.svg" alt="Voice requests flow to Codex for coding and testing" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Voice-run workspaces</h3>
      <p>Create and switch workspaces and sessions by voice. A new workspace waits for your confirmation.</p>
      <img src="assets/features/workspace.en.png" alt="Nova waits for approval to create a workspace" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>You control permissions</h3>
      <p>Review requests to run commands or access the network, then allow or deny them.</p>
      <img src="assets/features/permission.en.png" alt="Network permission request with allow and deny controls" width="100%">
    </td>
  </tr>
</table>

### Observe and stay connected

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Camera monitoring and timely alerts</h3>
      <p>Ask Nova to watch for a condition and tell you when it occurs.</p>
      <img src="assets/features/vision-camera.png" alt="Camera observation and spoken alert" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Take Nova with you</h3>
      <p>Connect your iPhone over Tailscale to Nova on macOS or an Ubuntu headless server, then talk and approve tasks from your phone.</p>
      <img src="assets/features/iphone.en.png" alt="iPhone home and connection settings" width="100%">
    </td>
  </tr>
</table>

## 3. Quickstart

Requirements: Node.js 22.13+, npm, Git, a logged-in `codex` executable (app-server is the only
Codex transport).

Install the release with npm.

```bash
npm install --global nova-audio-agent@latest
# open the shipped app; the first launch asks for one DashScope API key
novaaudio
# open the settings panel in the app
novaaudio config
# list the keys your voice pipeline needs; --online tests them
novaaudio doctor
```

Headless Ubuntu 22.04+: install `nova-audio-agent-server` with npm, configure it and initialize credentials; run `novaaudio-server start` and, in a second terminal, `novaaudio-server pair wss://your-host.ts.net` for a one-use QR. See the [configuration guide](docs/en/deployment/remote-server.md).

### Upgrading

Quit Nova, then run `npm install --global nova-audio-agent@latest`. To pin a version, use `nova-audio-agent@0.3.1`. Upgrades keep your local settings and data; moving back to an older version does not roll back data changes, so back up your Nova data first.

For headless Ubuntu 22.04+ x64, use `npm install --global nova-audio-agent-server@latest`.

For development from source:

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
```

Get an API key from [DashScope](https://platform.qianwenai.com) and set `DASHSCOPE_API_KEY`. That one key runs voice, memory, the camera and web search. Search goes through Bailian until you add a [Tavily](https://docs.tavily.com) `TAVILY_API_KEY`.

```bash
npm run start:client
# Open Workbench for this launch, overriding the saved startup preference
npm run start:workbench
```
The client includes microphone, camera, sound, settings, and external MCP controls. Try hovering over the desktop orb to get surprised :) Also you
may try build or run demo locally:

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

Native echo-cancelled capture (VoiceProcessingIO) is macOS-only. Wake detection uses that
capture when available; Windows, Linux source runs, and macOS fallback use Chromium
`getUserMedia` + AudioWorklet. While sleeping, microphone frames go only to the local
wake-word Worker; explicit mute stops wake detection. See
[wake-word setup](docs/en/getting-started.md#enable-a-wake-word).

### Support matrix

| Platform | Desktop app | Headless server | Connect iPhone |
|---|---|---|---|
| macOS arm64 | Yes, with native echo-cancelled capture | From source | From the desktop app |
| Windows x64 | Yes | — | — |
| Ubuntu 22.04+ x64 | Yes | npm package | Through the headless server |

| Layer | Providers | Default |
|---|---|---|
| Integrated voice | Qwen realtime, OpenAI realtime, Gemini Live, StepFun (preview) | Qwen `qwen-audio-3.0-realtime-plus` |
| Cascaded ASR / TTS | Volcengine Speech, Gemini, self-hosted (reference: Whisper / Breeze) | `volc.seedasr.sauc.duration` / `seed-tts-2.0` |
| Cascaded LLM | DeepSeek, Qwen / DashScope, Volcengine Ark, OpenAI, Gemini, self-hosted | DeepSeek `deepseek-flash` |
| Vision | Qwen-VL family, Doubao Seed | Off in conversation; Loop Camera uses its own model |
| Coding executor | Codex | Codex |
| Sources | Local folders, Google via Composio, Apple Mail and Calendar (macOS), Feishu | None until you authorize them |

Models, credentials and per-provider limits: [support matrix](docs/en/support-matrix.md).

## 4. Architecture

[![Nova personal agent architecture: interaction, context, coordination, execution and expression](assets/architecture/nova-personal-agent.en.png)](assets/architecture/nova-personal-agent.en.png)

*Conversation stays responsive, authorized context informs the work, and task results return as evidence. Speaking is a separate decision.*

- **Interaction:** Workbench, voice orb and phone clients share conversation and task controls. Background mode turns off the desktop microphone while work continues.
- **Context:** authorized sources feed the personal memory ledger and source-grounded suggestions. Document knowledge is separate; neither store owns live task state or grants permissions.
- **Coordination:** the conversation clarifies goals; the host owns confirmations, permissions and task state. The Task loop executes, checks evidence, then completes, corrects or waits. You can take over and return control.
- **Execution and expression:** Codex performs background work; camera monitoring and selected tools have their own lifecycles. Runtime events feed Proactive's selection of optional updates, Floor coordinates the speaking opportunity, and the conversation model expresses the update.

The **runtime blackboard** holds causal conversation and execution state; **personal memory** retains source-backed facts; **document knowledge** searches imported files. They have different roles and authority.

See [How Nova works](docs/en/architecture.md) for the product flow and the [architecture reference](docs/en/archs/00-overview.md) for runtime internals.

## 5. Documentation

| Read this | For |
|---|---|
| [Architecture](docs/en/architecture.md) | Modules and boundaries |
| [Glossary and invariants](docs/en/glossary.md) | Vocabulary and rules |
| [Getting started](docs/en/getting-started.md) | Setup and integrations |
| [Workbench](docs/en/workbench.md) · [Tasks](docs/en/tasks.md) · [Sources and connectors](docs/en/sources-and-connectors.md) | The main window, delegated work, and what Nova may read |
| [When should a voice agent speak?](docs/en/blog/2026-08-proactive-voice-agent-design-space.md) | Voice interaction design |
| [Node runtime migration archive](https://github.com/deepnovacore/NovaAudioAgent/tree/20a0812c0acb83b53cbad4b415d637dafff3c7f6/docs/archs/node-runtime-migration) | Migration-era plans in the history of tag `v0.1.0` |

## 6. Roadmap

- [x] **v0.3.0:** one main window for text and voice with Todos, Ideas, Goals, Feeds, Tasks and Profile; tasks with acceptance criteria, verified completion and takeover; memory-grounded suggestions; traceable, correctable and removable personal memory; user-authorized folders, email, calendars and Feishu conversations.
- [ ] **v0.4.0 (in development):** expand coding backends with Kimi Code and pi agent; add a GUI executor with AutoGLM as the first example, enabling collaboration across specialist agents.

Releases require feature and supported-platform acceptance. Ubuntu 22.04+ x64 desktop and headless npm packages are included in the candidate release checks.

## 7. Contribution

```bash
npm ci && npm run check && npm run build && npm test
```

Live integrations are credential- and hardware-dependent and never substitute for the
deterministic tests. Security reports: [SECURITY.md](SECURITY.md); contribution rules and
invariants: [CONTRIBUTING.md](CONTRIBUTING.md).

## 8. License

Copyright 2026 DeepNovaCore, [Apache License 2.0](LICENSE).
