<!-- Keep in sync with README.md -->

# Nova Audio Agent

[English](README.md) | **简体中文**

> **手中事不辍，口中言有度。**

[![CI](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB.svg)](pyproject.toml)
[![Architecture](https://img.shields.io/badge/Arch-Control%20Plane-7B2CBF.svg)](#3-架构)
[![Blog](https://img.shields.io/badge/Blog-Tradeoff%20Ruler-0B7285.svg)](docs/blog/2026-08-proactive-voice-agent-design-space.md)

Nova Audio Agent 是一个**常驻、通用语音 agent 的运行骨架（harness）**。小诺（Nova）负责让对话
始终应答如流，各个独立能力则在后台搜索、观察、操作设备，或完成更长的任务。

这不是一个聊天机器人框架，也不是工作流引擎。它关注的是另一个问题：
**当多件事同时发生时，agent 如何决定何时开口、何时派活、何时保持沉默。**
它是面向开发与评测的实验系统，而非开箱即用的消费级助手。

离我们最近的邻居是 [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent)——我们改编
了它的 macOS 语音采集 helper（见 [NOTICE](NOTICE)），也细读过它的进度播报设计。它把*如何让
agent 一边干活一边说话*回答得很好；而萦绕我们的，是镜像的另一问：开口本身何时值得——由谁决定、
以何种优先级、凭哪份记忆？这个上游问题正是本仓库要探究的；完整讨论见
[设计文章](docs/blog/2026-08-proactive-voice-agent-design-space.md#5-related-work)。

> **原则**：领域能力是可替换的执行能力；agent 的内核，是掌管生命周期、记忆、注意力与言语的
> 那一部分。

**初来乍到？** 先读[设计要义](docs/essence.md)——最短的设计说明；或直接跳到
[快速开始](#4-快速开始)把它跑起来。

## 1. 亮点

- **结构化的按通道记忆（channel-wise memory）。** 每个能力写入自己的只追加通道——
  `conversation`、`search`、`cam`、`watch`、`guard`，外加每个激活 executor 一条——每条记录都带
  信任级、优先级与结果。结构化的 intent / goal / authorization 只有 FastBrain 可写；模型调用
  读有界 `ContextView`，绝不直读原始记忆。
- **一推一拉的主动性（push-and-pull proactivity）。** 推：符合条件的环境观察先落入建议池，
  由 Surrogate 判断此刻是否值得开口——`speak=false` 是沉默，不是遗忘（紧急的 Guard 命中绕过
  建议池）。拉：同一份状态回答之后的提问，包括 realtime 路径的 `memory.recall` 工具。
  一次写入，择机定夺，同源作答。
- **异构 executor 与基于优先级的说话权仲裁。** 各 executor 并发运行；Floor 对每次发声裁决
  `allow`、`preempt` 或 `defer`，优先级绑定在触发事件上（用户 100 > guard 90 > executor 50 >
  环境观察 40）。模型无法给自己提权；被 defer 的话语落入建议池。
- **经由原生 app-server 的 Codex 实时转向（live steering）。** 在 realtime 路径上，Codex 运行
  于 `codex app-server` 之后（JSON-RPC `turn/start`、`turn/steer`）：用户新增的约束追加进正在
  执行的同一个 turn 而非推倒重来，受评测把关的契约为
  `run < turn_start < steer ≤ accept < completion`。

[![原始设计黑板上的 v3 运行时](assets/ideas/v3/nova-brain-v3-chalkboard-v3.png)](assets/ideas/v3/nova-brain-v3-chalkboard-v3.png)

*原始设计黑板上的 v3 运行时：一个事件循环，两个模型端口共读一份 ContextView，Memory 作共享
黑板，Floor 守着唯一的说话路径。*

> 📝 **设计文章**：
> [A Tradeoff Ruler for Proactive Voice Agents](docs/blog/2026-08-proactive-voice-agent-design-space.md)
> ——说话的决定该住在哪里，以及更强的模型到来时什么得以幸存。

## 2. 它建模的问题

一个实时 agent 身上不止一个时钟：

- 委派出去的工作还在运行，用户可能继续说话；
- executor 可能在拿到最终结果之前先发布进度；
- 摄像头或 guard 可能注意到没人明确问起的事情；
- 多个候选回应可能同时就绪，而同一时刻只有一个声音握有说话权。

把这一切塞进一个同步的"模型加工具"回合，要么阻塞对话，要么制造出多个抢话的声音。
Nova Audio Agent 选择把职责拆开——每个组件只拥有一种判断；完整词汇表钉在
[术语与不变量](docs/glossary.md)。

## 3. 架构

```mermaid
flowchart LR
  IN["Input"] --> SPINE["Runtime spine"]
  SPINE --> FAST["FastBrain"]
  SPINE --> EXEC["Executor slots"]
  EXEC -- "typed handoff" --> MEM["Memory"]
  MEM -- "bounded ContextView" --> FAST
  MEM --> POOL["Suggestion pool"] --> SUR["Surrogate"] --> FLOOR["Floor"] --> FAST
  FAST --> OUT["One speech path"]
```

这张图刻着几条不可逾越的边界：

1. 运行时派发 executor 工作，绝不在事件循环体内等它完成。
2. 每一条被接受的结果必须先抵达权威记忆，才能影响对话；executor 永远不直接对用户说话。
3. 只有 FastBrain 可以更新结构化的 intent、goal 与 authorization；模型调用读有界
   `ContextView`，不读未加约束的记忆。
4. 只有配置选中的 manifest 才会成为模型可见的工具。
5. 用户在等的结果直接唤醒 FastBrain；不请自来的建议必须走
   `Surrogate → Floor → FastBrain`——Floor 以 `allow`、`preempt`、`defer` 三种裁决定夺，
   优先级绑定在触发事件上、永远不由模型选择；被 defer 的话语落入建议池，而不是被丢弃。

这些是实现层的约束，不是提示词里的约定：delegate 的身份、期限与终态在运行时边界上逐一校验，
返回的结果被精确关联到产生它的那个 delegate 和通道——用户从不需要等 executor 干完活才能继续
对话。模块与规则见[架构](docs/architecture.md)与[术语与不变量](docs/glossary.md)。

### 3.1 先入记忆，后成言语

许多 agent 系统把进度首先当成通知问题。Nova Audio Agent 把它首先当成记忆问题：executor 发布
一次观察，Runtime 记录一次，控制面稍后再决定它该打断、该等待，还是该留作证据。

**一次写入，择机定夺，同源作答。（Publish once. Decide later. Answer from the same state.）**

亮点里的一推一拉，都是这条规则的投影：已开口的建议进入冷却，只有其通道上出现新证据才能重新
武装（re-arm），同一句话绝不会被定时器反复播放；而 `memory.recall` 日后读到的，正是推的一侧
写下的那些通道。这套设计把三个极易混为一谈的判断分了家：

| 问题 | 归属 |
|---|---|
| 发生了什么？ | Executor → 权威 Memory |
| 没人问：这个变化现在值得说吗？ | Surrogate，只面向符合条件的环境建议 |
| 用户问了：答案该怎么表达？ | FastBrain，基于有界的 `ContextView` |

### 3.2 为什么这不是 ReAct 循环

executor 的完成并不待在一个回合制的 `reason → act → observe` 循环里：模型可以派活、交还
控制权、继续响应新事件，进度与完成以因果事件返回，而不是一个阻塞式的工具结果。一个慢任务
可以在派发时得到一句回应，在有用的结果回来时再得到第二句；executor 也永远拿不到直通用户
扬声器的路径。更完整的论证见[设计要义](docs/essence.md)与
[v3 设计系列](docs/archs/v3/00-overview.md)。

## 4. 快速开始

环境要求：Python 3.11+、[uv](https://docs.astral.sh/uv/)、支持子模块的 Git、Node.js 22+
（可选的桌面应用需要），以及 macOS（Ambient Orb 原生音频采集需要）。

克隆仓库及其钉定的 Open-AutoGLM 子模块：

```bash
git clone --recurse-submodules \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
uv sync --dev
cp .env.example .env
```

使用文本 CLI 前，在 `.env` 中设置 `NOVA_AUDIO_AGENT_MODEL_API_KEY` 与 `TAVILY_API_KEY`，然后：

```bash
uv run nova-audio-agent --help
uv run nova-audio-agent demo dual-axis
uv run nova-audio-agent demo proactive
uv run nova-audio-agent chat --executor fast_sim
```

dual-axis 演示的是"一次 FastBrain 调用同时开口与派活"；proactive 演示的是 Surrogate 裁断一条
环境观察值不值得发声。`demo async | dual-axis | timeout | proactive | all` 覆盖四个验收场景，
`scorecard` 运行一次非门禁的真实模型评估，`./scripts/bootstrap_backend.sh` 是 Conda 替代方案。
交互式对话可用 `/quit`、`/exit`、文件结束符或 `Ctrl-C` 退出。

小诺是中文优先的：人设、生产提示词、工具描述、CLI 报错与默认音色均为中文。各真实集成——
确定性模拟器、Tavily 搜索、Home Assistant、Codex（默认 JSONL 后端，realtime 路径另有 live
app-server 后端）、AutoGLM、摄像头 Watch/Guard，以及可选的 Qwen 或火山引擎实时语音——均通过
环境变量配置；逐项安装、注意事项与完整变量参考见[中文上手指南](docs/getting-started.zh-CN.md)。

## 5. macOS Ambient Orb

Ambient Orb 是本地语音界面：

```bash
uv sync --extra vision --dev
./scripts/start_ambient_orb_macos.sh
```

默认本地摄像头和 `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` 视频回放均依赖 `vision` extra。

它会启动 Python realtime 后端、构建原生 VoiceProcessingIO helper，并拉起 Electron 渲染器
（上下文隔离、沙箱与窄 preload 桥）；需要 macOS、Node.js、`codex` 可执行文件、麦克风权限，
以及 `.env` 中所选语音 provider 的凭据。Qwen 仍是默认值；原生火山备选链路为
`Silero VAD v5.1.2 → Seed ASR → Doubao Seed 2.0 Pro → Seed TTS 2.0`，安装命令是
`uv sync --extra vision --extra volcengine --dev`。provider 事件与宿主的响应及 delegate 身份逐一关联，
播放确认为音频清除与完成加上围栏；Memory Board 视图可按请求渲染每条记忆通道的最新条目——
正是前文按通道记忆的可视化对照。

## 6. 仓库布局

```text
src/nova_audio_agent/           运行时脊柱、端口、Floor、上下文、模型网关与 CLI
src/nova_audio_agent/memory/    权威通道记忆与结构化用户状态
src/nova_audio_agent/executors/ 模拟器与真实能力适配器
src/nova_audio_agent/realtime/  Qwen/火山传输、会话桥、恢复、播放与遥测
desktop/ambient-orb/            Electron UI 与原生 macOS 音频 helper
tests/                          确定性的单元、场景、协议与仓库测试
docs/                           公开的架构、论证、指南、状态与设计系列
thirdparty/Open-AutoGLM/        钉定的公开上游 Git 子模块
resources/                      本地原始与剪辑媒体；有意被 Git 忽略
```

## 7. 文档

| 读这篇 | 为了 |
|---|---|
| [设计要义](docs/essence.md) | 立场与非目标 |
| [架构](docs/architecture.md) | 模块与边界 |
| [术语与不变量](docs/glossary.md) | 词汇与规则 |
| [中文上手指南](docs/getting-started.zh-CN.md) | 安装与集成 |
| [项目状态](docs/status.md) | 什么可用、什么仍在实验 |
| [v3 设计系列](docs/archs/v3/00-overview.md) | 详细设计论证 |
| [A Tradeoff Ruler for Proactive Voice Agents](docs/blog/2026-08-proactive-voice-agent-design-space.md) | 设计空间随笔 |
| [下游重实现指南](docs/guides/downstream-reimplementation.md) | 在别处重建这套架构 |

## 8. 开发与验证

```bash
# Python
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
uv build

# Electron
(cd desktop/ambient-orb && npm ci && npm test && npm run build)
```

在线集成有意依赖凭据与硬件；它们不能替代确定性测试，其输出应留在被忽略的本地产物目录中。
安全问题请按 [SECURITY.md](SECURITY.md) 私下报告；贡献指南（含每次改动必须守住的不变量）见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 9. 许可证

版权所有 2026 DeepNovaCore，以 [Apache License 2.0](LICENSE) 授权。第三方署名记录于
[NOTICE](NOTICE) 与桌面端[第三方声明](desktop/ambient-orb/THIRD_PARTY_NOTICES.md)。
