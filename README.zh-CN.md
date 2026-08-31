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
（[术语与不变量](docs/glossary.md)）。小诺站在用户一侧，而不是绑在某个项目上（见 §4）；这是
面向开发与评测的实验系统，不是拿来即用的成品助手。

最相关的工作是 [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) 。它把"怎么让 agent 边干活边说话"答得很好；我们追问的是
反面——开口这件事本身，什么时候才值得
（[设计文章](docs/blog/2026-08-proactive-voice-agent-design-space.md)）。


**第一次来？** 先读[设计要义](docs/essence.md)，或者直接跳到[快速开始](#3-快速开始)跑起来。

https://github.com/user-attachments/assets/94f4f199-ab5e-4c26-aef5-efb00cfe8bc0

## 1. 亮点

- **该报的进展，一条不漏。** 每个能力各写各的只追加通道，结果先落权威 Memory，才有资格进
  对话；长任务按固定节奏回报进展。忙起来顶多是晚点说，不会把这笔记录弄丢。
- **不是每句话都值得现在说。** `speak=false` 是沉默，不是遗忘：被 defer 的观察落回建议池，
  只有它引用的那个通道来了新证据才会重新上膛；`memory.recall` 之后仍用同一份状态回答。
- **要紧的话，抢得上麦。** Search、Camera、Watch、Guard、Codex 共用同一个仲裁器，优先级绑
  在触发事件上，模型自己说了不算——用户 100、Guard 90、在跑的执行器 50、环境观察 40。够到
  打断带的 Guard 命中，会把小诺自己说到一半的话掐掉；但绝不掐你的话。
- **管项目这件事，交给一个声音。** 一个语音入口通管所有命名工作区：各自隔离的 Codex home、
  可断可续的 Session，创建、切换、续作一律走 fail-closed 的提案—确认两步。
- **靠结构省 token，还能实时转向。** 交给 Codex 的只有一份限长的 work order，从不带对话
  历史；用户临时加的约束直接追加进正在跑的 `codex app-server` turn，不用推倒重来（见 §2）。
  先聊清楚再派单，也比让 Codex 跑错一轮再返工便宜：在一组内部算例上，这样能把 Codex 侧的
  token 支出压低约 31%（内部实测，本仓库未附复现脚本）。

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
- CI 会验证 macOS、Windows 和 Ubuntu 的源码构建。Ubuntu 目前只支持源码运行：装好依赖、配置
  `.env` 后，需要自行执行 `npm run start:client` 启动。
- tag 发布会在 installed-smoke 通过后生成带版本号的 Windows 未签名安装包；硬件验证和签名包仍
  待补（[项目状态](docs/status.md)）。

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

**Workspace** 是带独立 `CODEX_HOME` 的文件系统/Git 项目隔离单元；**Session** 是其中一条
可断可续的 Codex 线程。

生命周期操作——创建、切换、续作——一律两步走：语音先生成提案，携带该提案 ID 的
structured confirmation 才能落锤；拒绝、ID 对不上、重放，一律 fail closed。Codex 全局串行
执行，桌面客户端界面上只出现公开标签。语音只能新建托管目录，接入已有仓库要走
`NOVA_AUDIO_AGENT_CODEX_WORKSPACE`。桌面端还能打开当前托管 workspace，或经两道确认清空当前
乃至全部托管 workspace——清空只倒空目录，项目记录、显示名称、Codex 历史和 Session 元数据都
会留着。完整契约见[多项目 Workspace 交接](docs/multi-project-workspace-handoff.md)，保留
上限和凭据处理见[上手指南](docs/getting-started.zh-CN.md)。

再往上是两层记忆。可选开启的工作区图谱只记弱 `discussed_with` 线索——限量、低权威、够不到
主动建议的门槛、90 天不刷新就过期——而且小诺绝不会自己去读别的 workspace
（[v3 记忆卷](docs/archs/v3/02-memory.md)）。可选的 MyContext 边界再补一路个人层面的证据
来源：只读、不受信任、从不主动，只在显式召回时查询。仓库里不带 Nova 兼容的只读 adapter，
这条链路因此还没能端到端跑通；上游 MyContext 用的是 Elastic License 2.0，复用或捆绑之前要
先过法律与分发审查。

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
振幅脉动，Codex 干活时外圈多出一条轨道带——配色可选 Ember 或 Graphite。有项目操作等你点头
时，orb 会变成一张宿主兜底的确认卡：写明具体操作、标注「尚未执行」、给出自动取消的倒计时。

右键唤出 Memory Board 和设置面板；面板管配色、主动性档位、Codex 播报间隔、音色、管线形态、
Codex 可执行文件发现、托管 workspace 根目录，以及 §4 那几个 workspace 操作。改动先以草稿
形式留在窗口里，点**保存并重启**才会一次性写盘、刷新生效配置，并做恰好一次受控的后台重启，
配色也在这同一个提交点生效。API 密钥只写不读，走系统钥匙串加密，回读时只告诉你填没填。

## 6. 常见问题

### Windows 报 `project_directory_open_failed_home`

这通常不是 npm、构建或 Electron 的问题。Nova 启动时会打开 `%USERPROFILE%`；如果目录 owner
SID 与当前进程用户 SID 不一致，就会 fail closed。检查在
[`project_native_windows.c`](desktop/ambient-orb/native/project-native/project_native_windows.c#L707)，
调用入口在 [`project-directories.mjs`](desktop/ambient-orb/src/main/project-directories.mjs#L78)。
在 PowerShell 中修复并验证：

```powershell
icacls.exe "$env:USERPROFILE" /setowner "$env:USERDOMAIN\$env:USERNAME" /Q
(Get-Acl "$env:USERPROFILE").Owner
```

若 `icacls` 提示权限不足，请使用“以管理员身份运行”的 PowerShell。第二条命令应输出当前电脑
或域及用户名，之后重新执行 `npm run start:client`。无需加 `/T`：Nova 只检查用户目录本身。
诊断过程只读；修复只改该目录的 owner，不递归修改子目录。

## 7. 文档

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

## 8. 路线图

- [ ] **把级联管线做成更省钱的默认**——级联拓扑今天已经可选（火山 ASR、`qwen-flash`、
  火山 TTS），但它比集成 `qwen-audio-3.0-realtime-plus` 更省成本目前只是预期，不是实测；
  先做在线验证和成本对比，才谈得上拿它替换集成默认。
- [ ] **打通 MyContext 端到端**——过完 Elastic License 2.0 审查后交付 Nova 兼容的只读
  adapter；今天只有严格的 client 边界。
- [ ] **工作区图谱默认开启，补上情景记忆**——等浸泡验证攒够证据；今天图谱还是可选开启，
  会话级情景摘要也还没做。
- [ ] **通过 executor 端口接入更多 coding agent**——`ExecutorAdapter` 端口就是留给 ACP
  或各家原生协议的接缝；今天 Codex 是唯一后端。

## 9. 开发与验证

```bash
npm ci && npm run check && npm run build && npm test
```

在线集成刻意依赖凭据和硬件，替代不了确定性测试。安全问题请走私下渠道：
[SECURITY.md](SECURITY.md)；贡献规则和每次改动都要守住的不变量见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 10. 许可证

版权所有 2026 DeepNovaCore，以 [Apache License 2.0](LICENSE) 授权。第三方署名见
[NOTICE](NOTICE) 与[桌面端第三方声明](desktop/ambient-orb/THIRD_PARTY_NOTICES.md)。
