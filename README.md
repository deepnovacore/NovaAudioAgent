<!-- Keep in sync with README.zh-CN.md -->

# Nova Audio Agent

**English** | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-ControlPlane-7B2CBF.svg)](#2-architecture)
[![Blog](https://img.shields.io/badge/Blog-Design-0B7285.svg)](docs/blog/2026-08-proactive-voice-agent-design-space.md)
[![YouTube](https://img.shields.io/badge/YouTube-Demo(CN)-FF0000.svg)](https://youtu.be/t1c-2O-QsxE)


> **An always-on voice agent with restrained proactivity and the capability of workspace management.**

https://github.com/user-attachments/assets/061697f3-fff6-47d6-924b-8a29eef4ab45

## 1. Highlights

Nova Audio Agent is a **harness for an always-on, general-purpose voice agent**: Nova (小诺)
keeps responsive while doing long-running tasks in the background, reporting
**proper** progress at **proper** time.

A concurrent work [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) answers
*how to keep an agent talking while it works*, while we ask a step further — **when is talking
worth it at all** (see the [design post](docs/blog/2026-08-proactive-voice-agent-design-space.md) for more details).


- **Restrained proactivity:** Not all words are created equal, for example, *trivial events from codex not worth saying, milestones should be reported, guardians should take over*. The agent stays silent for plain coding progress and reports progress for milestones. Alerts have higher speaking rights, where the agent interrupts itself or even  user.
- **Workspace management.** No need to manage your workspaces manually as in codex, our agent does that for you. Workspaces/sessions can be created/switched via pure voice control(proposed and confirmed).
- **Intent clarification and save your tokens.** For under-specified requirements, the agent will first clarify your intent before proceeding to dispatch, which *saves about 31% tokens* in our internal tests.
- **Real-time steering**. Our codex executor is built upon native codex app-server instead of ACP, which allows real-time steering.

## 2. Architecture

[![Nova Audio Agent runtime architecture on a chalkboard](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

*One event loop, two model ports reading one ContextView, Memory as the shared blackboard,
Floor guarding the single speech path.*

Essential roles and ideas:
* **FastBrain model**: the model that interacts with users at front-end, using function-calling to update intent, dispatch work, recalling memory etc.
* **Surrogate model**: decides **when to speak**. When events get written into memory or suggestion pool, the surrogate model judges whether it worth reporting to the users.
* **Memory and ContextView**: short-term, events from different executors are stored in different channels. Only required information is compiled into the ContextView for FastBrain.
* **Executors**: produce **what to speak** and run completely async. We support multiple heterougenous executors like camera moniter and coding. It's scalable and extensible.

For more details about the architecture, check [Architecture](docs/architecture.md).



## 3. Quickstart

Requirements: Node.js 22+, npm, Git, a logged-in `codex` executable (app-server is the only
Codex transport).

Besides the shipped app from releases, you can also install using npm

```bash
npm install --global nova-audio-agent@0.1.1
# open the shipped app
novaaudio
# open the settings panel in the app
# get api key from dashscope and tavily to fill up 
novaaudio config
novaaudio doctor
```


For development from source:

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
```

Get API key from [DashScope](https://platform.qianwenai.com) and [Tavily](https://docs.tavily.com) . And then set `DASHSCOPE_API_KEY` and `TAVILY_API_KEY`.

```bash
npm run start:client
```
It ships with toggles of microphone, camera, sounds, the settings panel and workspace graph. Try hovering over the desktop orb to get surprised :) Also you may try build or run demo locally:

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

Note that native echo-cancelled capture (VoiceProcessingIO) is macOS-only; Windows and Linux use
  Chromium's audio stack.



## 4. Documentation

| Read this | For |
|---|---|
| [Architecture](docs/architecture.md) | Modules and boundaries |
| [Glossary and invariants](docs/glossary.md) | Vocabulary and rules |
| [Getting started](docs/getting-started.md) | Setup and integrations |
| [v0.2.0 specs](docs/specs/v0.2.0/00-overview.md) | In-progress feature contracts on `v0.2.0dev` |
| [A Tradeoff Ruler for Proactive Voice Agents](docs/blog/2026-08-proactive-voice-agent-design-space.md) | The design-space essay |

## 5. Roadmap
- [ ] **v0.2.0 (branch `v0.2.0dev`):** cross-platform Codex `on-request` approvals + YOLO; multi-round intake and WorkOrder planning; capability registry / MCP (MCP search opt-in until live verification, then default flip); private knowledge base; progress bubbles. Specs: [docs/specs/v0.2.0](docs/specs/v0.2.0/00-overview.md).
- [ ] Support more end-to-end and cascaded frontend pipelines.
- [ ] Integrate MyContext to support workspace-centric memory.
- [ ] More coding agents through the executor port.

## 6. Contribution

```bash
npm ci && npm run check && npm run build && npm test
```

Live integrations are credential- and hardware-dependent and never substitute for the
deterministic tests. Security reports: [SECURITY.md](SECURITY.md); contribution rules and
invariants: [CONTRIBUTING.md](CONTRIBUTING.md).

## 7. License

Copyright 2026 DeepNovaCore, [Apache License 2.0](LICENSE).
