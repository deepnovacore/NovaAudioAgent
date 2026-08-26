<!-- Keep in sync with README.md -->

# Nova Audio Agent

**常驻在线、一人打理所有项目、主动而有分寸的语音 agent——手中事不辍，口中言有度。**

[English](README.md) | **简体中文**

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-Control%20Plane-7B2CBF.svg)](#2-架构)
[![Blog](https://img.shields.io/badge/Blog-Tradeoff%20Ruler-0B7285.svg)](docs/blog/2026-08-proactive-voice-agent-design-space.md)

Nova Audio Agent 是一套**常驻通用语音 agent 的运行骨架（harness）**：小诺（Nova）在前台把
对话接得又快又稳，各路独立能力在后台搜索、观察、操控设备，或者慢慢把长任务做完。

它不是聊天机器人框架，也不是工作流引擎——它要回答的是**几件事同时发生时，agent 该什么时候
开口、什么时候派活、什么时候闭嘴**；每个组件只负责一种判断
（[术语与不变量](docs/glossary.md)）。这是一套面向开发与评测的实验系统，不是拿来即用的
成品助手。小诺站在用户一侧，而不是绑在某个项目上：同一个语音入口，照看手头所有命名工作区
——Workspace 是项目之间的文件系统隔离边界，每个任务则是其中一条可断可续的 Session。

我们改编了 [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) 的 macOS 语音
采集 helper（[NOTICE](NOTICE)）。它把"怎么让 agent 边干活边说话"答得很好；我们追问的是
反面——开口这件事本身，什么时候才值得
（[设计文章](docs/blog/2026-08-proactive-voice-agent-design-space.md)）。

> **原则**：领域能力是随时可换的执行能力；agent 的内核，是掌管生命周期、记忆、注意力与
> 言语的那部分。

**第一次来？** 先读[设计要义](docs/essence.md)，或者直接跳到[快速开始](#3-快速开始)跑起来。

## 1. 亮点

- **按通道组织的结构化记忆。** 每个能力各写各的只追加通道；模型调用只能读有边界的
  `ContextView`，碰不到原始记忆。
- **一推一拉的主动性。** 环境观察先进建议池，何时开口由 Surrogate 定夺——`speak=false`
  是沉默，不是遗忘；`memory.recall` 用同一份状态回答之后的提问。
- **按优先级仲裁说话权。** 每次发声都要过 Floor 这一关：`allow`、`preempt` 或 `defer`；
  优先级绑在触发事件上，模型自己说了不算。
- **一个语音入口，通管多个工作区。** 各自隔离的 Codex home、可断可续的 Session、
  fail-closed 的提案—确认两步走。
- **靠结构省 token，还能实时转向。** 交给 Codex 的只有一份限长的 work order，从不带对话
  历史；进度先摘要再回流，用户临时加的约束直接追加进正在跑的 `codex app-server` turn，
  不用推倒重来（见 §2）。

## 2. 架构

[![设计黑板上的 Nova Audio Agent 运行时架构](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)](assets/ideas/v3/nova-audio-agent-runtime-chalkboard.png)

*一个事件循环，两个模型端口共读一份 ContextView，Memory 是公共黑板，Floor 把守唯一的
说话通路。*

几条越不过去的边界，全部在运行时层面校验，不靠提示词自觉（[架构](docs/architecture.md)）：

1. 运行时把活派出去就走，绝不在事件循环体里干等结果。
2. 结果先落权威记忆，才有资格影响对话；executor 从来没有直接对用户说话的通路。
3. 结构化的 intent、goal 与 authorization，只有 FastBrain 改得动。
4. 只有配置点名的 manifest，才会变成模型看得见的工具。
5. 不请自来的建议必须排队走 `Surrogate → Floor → FastBrain`；被 defer 的话落回建议池，
   不会被丢掉。

进度首先是记忆问题，其次才是通知问题——**一次写入，择机定夺，同源作答**——三个容易搅在
一起的判断由此分了家：

| 问题 | 归谁管 |
|---|---|
| 发生了什么？ | Executor → 权威 Memory |
| 没人问：这个变化值得现在说吗？ | Surrogate，只管符合条件的环境建议 |
| 用户问了：答案该怎么组织？ | FastBrain，基于有边界的 `ContextView` |

前脑管对话，Codex 是窄边界后面的慢速工作脑：

- 跨过边界的只有一份限长 work order——从不带对话历史；
- 进度在 Codex 投影边界先做摘要，再过 Surrogate 这道注意力闸门；
- 对话通道涨到固定水位就压缩；`codex__steer` 把新约束追加进正在跑的 turn，不重新派单；
- 工作区图谱的上下文只能按固定预算进入模型调用。

## 3. 快速开始

环境要求：Node.js 22+、npm、Git、登录好的 `codex` 可执行文件（Codex 只走 app-server 这一种
transport），以及受支持的桌面会话；编译原生 helper 还需要对应平台的工具链
（[上手指南](docs/getting-started.zh-CN.md)）。各平台的验证程度并不一样：

- 原生回声消除采集（VoiceProcessingIO）只有 macOS 有；Windows 和 Linux 走 Chromium 音频栈。
- CI 只能手动触发，而且目前只跑 Windows runner；三平台签名候选、clean-machine、硬件验证和
  发布证据都还没落地（[项目状态](docs/status.md)）。
- unsigned 打包工作流只出 Windows artifact；release-candidate 工作流的 Linux artifact 只做
  格式校验，不签名（[上手指南](docs/getting-started.zh-CN.md)）。

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
```

默认的集成 Qwen 桌面端要把 `DASHSCOPE_API_KEY` 和 `TAVILY_API_KEY` 都配上——Search 是常驻
装配的，就算没把它选成 executor，Tavily 也照样是必填项。

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

`diagnose` 不连 provider、不开设备。小诺中文优先：人设、提示词、默认音色都是中文；各项
集成的安装步骤和完整变量表见[上手指南](docs/getting-started.zh-CN.md)。

## 4. 一个助理，多个工作区

小诺的多项目能力立在两个名词上：**Workspace** 是带独立 `CODEX_HOME` 的文件系统/Git 项目
隔离单元；**Session** 是其中一条可断可续的 Codex 线程。

生命周期操作——创建、切换、续作——一律两步走：语音先生成提案，携带该提案 ID 的
structured confirmation 才能落锤；拒绝、ID 对不上、重放，一律 fail closed。切换分阶段
确认，Codex 全局串行执行，桌面客户端界面上只出现公开标签。语音只能新建托管目录，接入已有
仓库要走 `NOVA_AUDIO_AGENT_CODEX_WORKSPACE` 启动配置。完整契约见
[多项目 Workspace 交接](docs/multi-project-workspace-handoff.md)，保留上限和凭据处理见
[上手指南](docs/getting-started.zh-CN.md)。

再往上是两层记忆。可选开启的工作区图谱只记弱 `discussed_with` 线索——限量、低权威、够不到
主动建议的门槛、90 天不刷新就过期——而且小诺绝不会自己去读或翻看别的 workspace
（[v3 记忆卷](docs/archs/v3/02-memory.md)）。可选的 MyContext 边界再补一路个人层面的证据
来源——只读、不受信任、从不主动，只在显式召回时查询；仓库里不带 Nova 兼容的 adapter，
这条链路因此还没能端到端跑通；上游 MyContext 用的是 Elastic License 2.0，复用或捆绑之前
要先过法律与分发审查。

```bash
NOVA_AUDIO_AGENT_CODEX_WORKSPACE=/absolute/path/to/initial/repository
NOVA_AUDIO_AGENT_WORKSPACE_GRAPH_ENABLED=true
NOVA_AUDIO_AGENT_MYCONTEXT_PROVIDER_URL=http://127.0.0.1:PORT/base
```

## 5. Nova Desktop

Nova Desktop 是本地语音界面。配好 `.env` 之后：

```bash
npm run start:client
```

启动器会拉起 Node 运行时，外加一个开了沙箱和上下文隔离的 Electron 渲染器；它需要 `codex`
可执行文件、麦克风权限和 `TAVILY_API_KEY`；`DASHSCOPE_API_KEY` 仅集成 Qwen 与级联 Qwen
需要，级联 Ark 则需要 `ARK_API_KEY` 加 `DOUBAO_BIGMODEL_API_KEY`。管线形态、密钥复用和
设置面板的行为见[上手指南](docs/getting-started.zh-CN.md)。

orb 是一片 Canvas 2D 粒子场，状态全靠粒子行为传达——听你说话时向内聚拢，自己说话时随播放
振幅脉动，Codex 干活时外圈多出一条轨道带——配色可选 Ember 或 Graphite。右键唤出
Memory Board（逐通道展示最新记忆条目）和设置面板（配色、主动性档位、Codex 播报间隔、音色，
以及走系统钥匙串加密的 API 密钥）。

## 6. 文档

上手指南有中文版，其余文档目前只有英文。

| 读这篇 | 为了 |
|---|---|
| [设计要义](docs/essence.md) | 立场与非目标 |
| [架构](docs/architecture.md) | 模块与边界 |
| [术语与不变量](docs/glossary.md) | 词汇与规则 |
| [上手指南](docs/getting-started.zh-CN.md) | 安装与集成 |
| [项目状态](docs/status.md) | 什么可用、什么仍在实验 |
| [多项目 Workspace 交接](docs/multi-project-workspace-handoff.md) | 完整的 Workspace/Session 契约 |
| [A2A](docs/a2a.md) | agent 之间的边界 |
| [v3 设计系列](docs/archs/v3/00-overview.md) | 详细的设计论证 |
| [A Tradeoff Ruler for Proactive Voice Agents](docs/blog/2026-08-proactive-voice-agent-design-space.md) | 设计空间随笔 |

## 7. 路线图

- [ ] **打通 MyContext 端到端**——过完 Elastic License 2.0 审查后交付 Nova 兼容的只读
  adapter；今天只有严格的 client 边界。
- [ ] **工作区图谱默认开启，补上情景记忆**——等浸泡验证攒够证据；今天图谱还是可选开启，
  会话级情景摘要也还没做。
- [ ] **通过 executor 端口接入更多 coding agent**——`ExecutorAdapter` 端口就是留给 ACP
  或各家原生协议的接缝；今天 Codex 是唯一后端。

## 8. 开发与验证

```bash
npm ci && npm run check && npm run build && npm test
```

在线集成刻意依赖凭据和硬件，替代不了确定性测试。安全问题请走私下渠道：
[SECURITY.md](SECURITY.md)；贡献规则和每次改动都要守住的不变量见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 9. 许可证

版权所有 2026 DeepNovaCore，以 [Apache License 2.0](LICENSE) 授权。第三方署名见
[NOTICE](NOTICE) 与[桌面端第三方声明](desktop/ambient-orb/THIRD_PARTY_NOTICES.md)。
