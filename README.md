<!-- Keep in sync with README.zh-CN.md -->

# Nova Audio Agent

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-ControlPlane-7B2CBF.svg)](#2-architecture)
[![Blog](https://img.shields.io/badge/Blog-Design-0B7285.svg)](docs/en/blog/2026-08-proactive-voice-agent-design-space.md)


> **An always-on voice agent with restrained proactivity and the capability of workspace management.**


> **Branch preview — Nova Visor:** [Approved transparent desktop HUD concept and demo goals](docs/DESKTOP_VISOR_DEMO.md). A Jarvis-style interactive desktop layer that keeps normal apps visible and usable. Static concept only; the desktop overlay is not implemented yet.

## News

- **2026-09-24 · 🎉 [v0.2.3 Released!](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.3)** — A guided first run: one DashScope API Key is enough to start talking, a setup window tests the key before saving, and search, camera and memory switch themselves on once their key is present.

- **2026-09-21 · 🎉 [v0.2.2 Released!](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.2)** — Ubuntu 22.04+ x64 joins macOS and Windows, with npm desktop installation and the new `nova-audio-agent-server` package for headless hosting and terminal QR pairing.

- **2026-09-21 ·** **🎉 [v0.2.0 Released!](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.0)**
  Configurable voice pipelines, personal memory, and a bilingual desktop experience, now available for macOS and Windows.
  - Cross-platform approvals for sandbox network access and command execution.
  - A leaner voice layer; workspace/session scheduling moves into the coding executor.
  - Pluggable ASR / LLM / TTS pipelines, decoupled from QwenAudioRealtime.
  - Custom MCP servers for search and RAG; wake words “你好星核” and “Hi Nova”. Chinese/English interface and system prompts.
  - Personal memory with mem0 / VoiceMem.
  - An iPhone client connected to your PC runtime over Tailscale.
- **2026-08-31 · v0.1.0** — Always-on voice, background Codex tasks, live steering, workspace/session management, and selective progress updates.

## 1. Highlights

Nova Audio Agent is a **harness for an always-on, general-purpose voice agent**: Nova (小诺)
keeps responsive while doing long-running tasks in the background, reporting
**proper** progress at **proper** time.

A concurrent work [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) answers
*how to keep an agent talking while it works*, while we ask a step further — **when is talking
worth it at all** (see the [design article](docs/en/blog/2026-08-proactive-voice-agent-design-space.md) for more details).


- **Restrained proactivity.** Important progress gets reported; routine updates stay quiet, and reminders never interrupt you while you speak.
- **Voice-run workspaces.** Create and switch workspaces and sessions by voice, with your confirmation.
- **Clarify before acting.** Nova asks about unclear requirements before handing work to the background executor.
- **Steer while it runs.** Add requirements and constraints by voice while a task is in progress.

## 2. Architecture

[![Nova Audio Agent runtime architecture on a chalkboard](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

*One event loop, two model ports reading one ContextView, Memory as the shared blackboard,
Floor guarding the single speech path.*

Essential roles and ideas:

* **FrontBrain model**: the realtime model that interacts with users, using the minimal host/native surface to dispatch work, cancel it, confirm host proposals, recall memory, and search. Revision-bound intake slots remain host-owned.
* **Surrogate model**: decides **when to speak**. When events get written into memory or suggestion pool, the surrogate model judges whether it worth reporting to the users.
* **Memory and ContextView**: short-term events from different capabilities are stored in different channels. Only bounded evidence and intake facts are compiled into ContextView for FrontBrain.
* **Executors and controllers**: role-based manifests run asynchronous work; an AgentController registry owns model-facing controllers and hidden Vision watch/guard channels. Camera frames go directly to the selected VLM; monitoring owns its complete loop.

For more details about the architecture, check [Architecture](docs/en/architecture.md).



## Main Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Voice Vibe Coding</h3>
      <p>Describe a feature and refine it by voice while Codex writes and tests the code. Nova reports key milestones and keeps routine progress quiet.</p>
      <img src="assets/features/coding.en.svg" alt="Voice requests flow to Codex for coding and testing" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Understands what you mean</h3>
      <p>Describe your goal naturally. Nova asks for the missing details before turning it into a task.</p>
      <img src="assets/features/conversation.en.png" alt="Nova clarifies the requested application before starting" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Manage workspaces by voice</h3>
      <p>Create a workspace, switch projects, or resume a session—with your confirmation.</p>
      <img src="assets/features/workspace.en.png" alt="Nova asks to create the Pet Manager workspace" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>You control permissions</h3>
      <p>Review requests to run commands or access the network, then allow or deny them.</p>
      <img src="assets/features/permission.en.png" alt="Network permission request with allow and deny controls" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Camera monitoring and timely alerts</h3>
      <p>Ask Nova to watch for a condition and tell you when it occurs.</p>
      <img src="assets/features/vision-camera.png" alt="Camera observation and spoken alert" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>Bring your tools and knowledge</h3>
      <p>Configure ASR / LLM / TTS and MCP; ask questions across your documents.</p>
      <img src="assets/features/knowledge.en.png" alt="Knowledge-base answer using the CN-27 demo documents" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Memory that stays with you</h3>
      <p>mem0 recalls personal context across conversations, with source text you can inspect.</p>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/features/mem0-dark.en.png">
        <img src="assets/features/mem0.en.png" alt="Four local mem0 memories with source details" width="100%">
      </picture>
    </td>
    <td width="50%" valign="top">
      <h3>Take Nova with you</h3>
      <p>Connect your iPhone over Tailscale to talk and approve tasks on your PC.</p>
      <img src="assets/features/iphone.en.png" alt="iPhone home and connection settings" width="100%">
    </td>
  </tr>
</table>

<sub>Demo data; screenshots cleaned up, composited and translated for presentation.</sub>

## 3. Quickstart

Requirements: Node.js 22+, npm, Git, a logged-in `codex` executable (app-server is the only
Codex transport).

Besides the shipped app from releases, you can also install using npm

```bash
npm install --global nova-audio-agent@0.2.3
# open the shipped app; the first launch asks for one DashScope API key
novaaudio
# open the settings panel in the app
novaaudio config
# list the keys your voice pipeline needs; --online tests them
novaaudio doctor
```

Headless Ubuntu 22.04+: install `nova-audio-agent-server` with npm, configure it and initialize credentials; run `novaaudio-server start` and, in a second terminal, `novaaudio-server pair wss://your-host.ts.net` for a one-use QR. See the [configuration guide](docs/en/deployment/remote-server.md).

For development from source:

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
```

Get an API key from [DashScope](https://platform.qianwenai.com) and set `DASHSCOPE_API_KEY`. That one key runs voice, memory, the camera and web search. Search goes through Bailian until you add a [Tavily](https://docs.tavily.com) `TAVILY_API_KEY`.

```bash
npm run start:client
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

## 4. Documentation

| Read this | For |
|---|---|
| [Architecture](docs/en/architecture.md) | Modules and boundaries |
| [Glossary and invariants](docs/en/glossary.md) | Vocabulary and rules |
| [Getting started](docs/en/getting-started.md) | Setup and integrations |
| [When should a voice agent speak?](docs/en/blog/2026-08-proactive-voice-agent-design-space.md) | Voice interaction design |
| [Node runtime migration archive](https://github.com/deepnovacore/NovaAudioAgent/tree/20a0812c0acb83b53cbad4b415d637dafff3c7f6/docs/archs/node-runtime-migration) | Migration-era plans in the history of tag `v0.1.0` |

## 5. Roadmap

- [ ] **v0.3.0:** bring text and voice into one main window with conversation, activity, task and memory views; add memory-grounded suggestions and follow-up; make personal memories traceable, correctable and removable; connect user-authorized folders, email, calendars and Feishu conversations.
- [ ] **v0.4.0:** expand coding backends with Kimi Code and pi agent; add a GUI executor with AutoGLM as the first example, enabling collaboration across specialist agents.

Releases require feature and supported-platform acceptance. Ubuntu 22.04+ x64 desktop and headless npm packages are included in the candidate release checks.

## 6. Contribution

```bash
npm ci && npm run check && npm run build && npm test
```

Live integrations are credential- and hardware-dependent and never substitute for the
deterministic tests. Security reports: [SECURITY.md](SECURITY.md); contribution rules and
invariants: [CONTRIBUTING.md](CONTRIBUTING.md).

## 7. License

Copyright 2026 DeepNovaCore, [Apache License 2.0](LICENSE).
