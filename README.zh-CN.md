<!-- Keep in sync with README.md -->

# Nova Audio Agent

[English](README.md) | **简体中文**

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-ControlPlane-7B2CBF.svg)](#2-架构)
[![Blog](https://img.shields.io/badge/Blog-Design-0B7285.svg)](docs/blog/2026-08-proactive-voice-agent-design-space.md)
[![YouTube](https://img.shields.io/badge/YouTube-Demo-FF0000.svg)](https://youtu.be/t1c-2O-QsxE)


> **Agent 常驻在线、主动但是有分寸、通过语音帮你管理所有工作区 -- 干活不停，言语有度**

https://github.com/user-attachments/assets/0ca76117-f6d2-46fc-80c3-8a8cee603fc6

## 1. 核心特性

Nova Audio Agent **常驻通用语音 agent**：小诺（Nova）负责在前台和用户进行实时对话，长任务则交给后台各路能力异步去做，拿到的信息由小诺进行筛选、转述、只在合适的时机说重要的事情。

同期工作 [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) 回答的是
「怎么让 agent 边干活边说话」；我们在此基础上又追问了一层——**开口这件事，什么时候才值得**
（详见[设计文档](docs/blog/2026-08-proactive-voice-agent-design-space.md)）。


- **主动有分寸：** 话有轻重。Coding的琐碎进度不必说，里程碑应该汇报；Guardian 告警（火灾、警报一类）说话权更高，agent 可以打断自己甚至打断用户。目前绝大部分的全双工模型都不具备这样的主动性 (Proactivity)。
- **语音管工作区。** 不必像 Codex 那样自己切工作区，Agent 帮你代劳，全程通过语音创建和、切换 workspace / session，提案会让你确认。
- **先问清再派活，省 token。** 需求说不清时，Agent 先澄清意图再下发，在内部测试用例上大约节省 **31% token**。
- **实时 steer 你的 coding agent。** Codex执行器基于原生 app-server而非ACP实现，任务进行中可以随时加约束。

## 2. 设计架构

[![Nova Audio Agent 运行时架构](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

*一个事件循环，两个模型端口共读一份 ContextView，Memory 当公共黑板，Floor 把守唯一说话通路。*

几个关键角色：
* **FastBrain：** 前台交互模型，用函数调用更新意图、派活、召回记忆。
* **Surrogate：** 决定**何时开口**。事件写入 Memory 或建议池后，由它判断值不值得告诉用户。
* **Memory 与 ContextView：** Memory 短期、分通道；摄像头监控、搜索、编码等执行器分开记录，只有需要的信息才编进 ContextView 给 FastBrain。
* **Floor：** 说话权。不同事件自带不同优先级。
* **Executor：** 产出**说什么**，完全异步。已支持摄像头 watch/guardian、Codex 等异构能力，你可以轻松扩展。
* **Compressor：** 对话变长后，短期记忆可能撑爆 FastBrain 和 Surrogate 的上下文，Agent用摘要模型自动压缩。

架构细节见 [架构](docs/architecture.md)。



## 3. 快速开始

环境要求：Node.js 22+、npm、Git、已登录的 `codex` 可执行文件（Codex 只走 app-server），以及受支持的桌面会话。

使用打包好的桌面端时，可以在任意目录安装并启动：

```bash
npm install --global nova-audio-agent@0.1.0
novaaudio
novaaudio config
novaaudio doctor
```

CLI 会先校验桌面产物的 SHA-256，再缓存到 `~/.nova-audio-agent/cli/releases/`。当前桌面产物尚未签名，macOS Gatekeeper 或 Windows SmartScreen 可能会显示安全警告。

从源码开发时：

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
```

默认集成 Qwen 桌面端需配置 `DASHSCOPE_API_KEY` 和 `TAVILY_API_KEY`——Search 始终会装配，即便没选它当 executor，Tavily 也是必填。

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

原生回声消除采集（VoiceProcessingIO）仅 macOS 可用；Windows 与 Linux 走 Chromium 音频栈。

启动桌面应用：
```bash
npm run start:client
```
自带麦克风、摄像头、声音开关，以及设置面板和工作区图谱。把鼠标悬在桌面 orb 上，会有惊喜。


## 4. 文档

| 读这篇 | 为了 |
|---|---|
| [架构](docs/architecture.md) | 模块与边界 |
| [术语与不变量](docs/glossary.md) | 核心常量 |
| [上手指南](docs/getting-started.zh-CN.md) | 安装与集成 |
| [A2A Discussion](docs/a2a.md) | A2A 扩展脑暴 |
| [A Tradeoff Ruler for Proactive Voice Agents](docs/blog/2026-08-proactive-voice-agent-design-space.md) | 设计博客 |

## 5. 路线图

- [ ] **支持更多端到端与级联前端管线。**
- [ ] **接入 MyContext，做以工作区为中心的记忆。**
- [ ] **通过 executor 端口接入更多 coding agent。**

## 6. 贡献

```bash
npm ci && npm run check && npm run build && npm test
```

安全问题见 [SECURITY.md](SECURITY.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 7. 许可证

版权所有 2026 DeepNovaCore，[Apache License 2.0](LICENSE)。
