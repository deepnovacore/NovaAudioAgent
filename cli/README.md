# Nova Audio Agent

![Nova Audio Agent chalkboard architecture](https://raw.githubusercontent.com/deepnovacore/NovaAudioAgent/main/assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

**An always-on voice agent with restrained proactivity and voice-controlled workspaces.**

[![npm](https://img.shields.io/npm/v/nova-audio-agent.svg)](https://www.npmjs.com/package/nova-audio-agent)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/deepnovacore/NovaAudioAgent/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](https://nodejs.org)

[Website](https://deepnovacore.github.io/NovaAudioAgent/en) ·
[GitHub](https://github.com/deepnovacore/NovaAudioAgent) ·
[简体中文](https://github.com/deepnovacore/NovaAudioAgent/blob/main/README.zh-CN.md) ·
[Watch the demo (Chinese)](https://youtu.be/t1c-2O-QsxE)

Nova (小诺) keeps a conversation going while longer tasks run in the background.
It reports useful milestones, clarifies requests, and lets you steer work through
voice without narrating every small step.

![Nova in conversation](https://raw.githubusercontent.com/deepnovacore/NovaAudioAgent/v0.2.0/assets/features/conversation.en.png)

This package provides the `novaaudio` command, which installs and launches the
desktop application. You do not need to clone or build the repository.

## Install

Requires **Node.js 22.13.0 or newer**, npm, and **macOS on Apple Silicon**,
**Windows x64**, or **Ubuntu 22.04+ x64** with a desktop session. Intel Macs and
Linux ARM64 are not covered. Linux requires Chromium user namespaces to be
permitted by the host or container policy.
The application is not yet signed, so macOS Gatekeeper and Windows SmartScreen
will warn on first launch.

```bash
npm install --global nova-audio-agent
```

### Preview channel

The v0.3 preview uses npm's `preview` tag; `latest` stays on the stable release.

```bash
# Install or update the preview
npm install --global nova-audio-agent@preview
novaaudio
# Pin this preview exactly
npm install --global nova-audio-agent@0.3.0-preview.1
# Switch back to the stable CLI
npm install --global nova-audio-agent@latest
```

Quit Nova before switching channels. Both channels use the same local settings and data; switching the CLI does not roll back data changes. Back up your Nova data before trying a preview.

For headless Ubuntu 22.04+ x64, use `npm install --global nova-audio-agent-server@preview` (or `@latest` for stable).

## Configure

Run `novaaudio`. The first launch downloads the app and opens a setup window
that asks for one key and tests it before you start:

- **[DashScope](https://platform.qianwenai.com)** — the default Qwen realtime voice service, plus memory, the camera and web search. Required.
- **[Tavily](https://docs.tavily.com)** — web search through Tavily instead of Bailian. Optional.
- **Codex** — a logged-in Codex executable, for coding tasks. Optional. See the [setup guide](https://deepnovacore.github.io/NovaAudioAgent/en/docs/getting-started).

Allow microphone access when prompted.

## Run

```bash
novaaudio
```

Hover over the desktop orb to reach its controls.

## Why Nova?

- **Talk while work continues.** Long-running tasks execute in the background while Nova stays available for conversation.
- **Progress worth hearing.** Restrained proactivity surfaces meaningful updates instead of reading out every coding event.
- **Manage workspaces by voice.** Create or switch workspaces and sessions through proposals you confirm.
- **Steer ongoing work.** The Codex integration uses its native app-server transport, so you can redirect a task while it runs.

## Commands

| Command | What it does |
| --- | --- |
| `novaaudio` or `novaaudio start` | Download the desktop app if needed, then launch it |
| `novaaudio config` | Download the app if needed, then open its settings |
| `novaaudio doctor` | Inspect platform support, local installation, and which keys the voice pipeline needs |
| `novaaudio doctor --online` | Also test keys set in the environment against their provider |
| `novaaudio --version` | Print the desktop release version used by the CLI |
| `novaaudio --help` | Show command help |

## How it works

The CLI downloads the matching desktop release from
[GitHub Releases](https://github.com/deepnovacore/NovaAudioAgent/releases) into
`~/.nova-audio-agent/cli/releases/` and verifies its published SHA-256 digest
before launching it. It reuses the desktop client's encrypted settings store and
never reads or prints secret values.

Run `novaaudio doctor` to see which release is installed and which voice keys
are still missing. `novaaudio config` opens the full settings for the other
features.

For headless Ubuntu 22.04+, install `nova-audio-agent-server` and use `novaaudio-server start`; `novaaudio-server pair wss://your-host.ts.net` shows a terminal pairing QR after configuring the service.

## Learn more

- [Getting started and integrations](https://deepnovacore.github.io/NovaAudioAgent/en/docs/getting-started)
- [How Nova works](https://deepnovacore.github.io/NovaAudioAgent/en/docs/architecture)
- [Design: when should a proactive voice agent speak?](https://github.com/deepnovacore/NovaAudioAgent/blob/main/docs/en/blog/2026-08-proactive-voice-agent-design-space.md)
- [Report an issue](https://github.com/deepnovacore/NovaAudioAgent/issues)
- [Build from source and contribute](https://github.com/deepnovacore/NovaAudioAgent/blob/main/CONTRIBUTING.md)

## License

Copyright 2026 DeepNovaCore.
[Apache License 2.0](https://github.com/deepnovacore/NovaAudioAgent/blob/main/LICENSE).
