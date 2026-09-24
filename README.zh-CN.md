<!-- Keep in sync with README.md -->

# Nova Audio Agent

[English](README.md) | **简体中文**

[![CI](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/deepnovacore/NovaAudioAgent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](package.json)
[![Architecture](https://img.shields.io/badge/Arch-ControlPlane-7B2CBF.svg)](#2-架构)
[![Blog](https://img.shields.io/badge/Blog-Design-0B7285.svg)](docs/en/blog/2026-08-proactive-voice-agent-design-space.md)
[![YouTube](https://img.shields.io/badge/YouTube-Demo-FF0000.svg)](https://youtu.be/t1c-2O-QsxE)


> **Agent 常驻在线、主动但是有分寸、通过语音帮你管理所有工作区 -- 干活不停，言语有度**

https://github.com/user-attachments/assets/061697f3-fff6-47d6-924b-8a29eef4ab45

> **分支预览 · Nova Visor：** [已选定的透明桌面 HUD 效果与 Demo 目标](docs/DESKTOP_VISOR_DEMO.md)。面向“可交互桌面壁纸”的 Jarvis 体验，保留正常电脑操作。当前为静态概念展示，桌面叠加层尚未实现。

## News

- **2026-09-24 · 🎉 [v0.2.3 已发布！](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.3)** — 首次启动更顺手：只要一个 DashScope API Key 就能开始对话，设置窗口会先测试密钥再保存；搜索、摄像头与记忆在配好对应密钥后自动启用。

- **2026-09-21 · 🎉 [v0.2.2 已发布！](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.2)** — 新增 Ubuntu 22.04+ x64 桌面 npm 安装与启动，以及支持终端二维码配对的无头服务包 `nova-audio-agent-server`；继续支持 macOS 和 Windows。

- **2026-09-21 ·** **🎉 [v0.2.0 正式发布！](https://github.com/deepnovacore/NovaAudioAgent/releases/tag/v0.2.0)**
  可配置语音管线、个人记忆与双语桌面体验，现已提供 macOS 和 Windows 版本。
  - 完善跨平台审批：沙箱网络访问、命令执行等请求转交前台确认。
  - 精简快脑工具，将 workspace/session 调度下沉至编码执行器。
  - 接入可配置 ASR / LLM / TTS 的级联管线，协议与 QwenAudioRealtime 解耦。
  - 支持自定义 MCP、搜索与 RAG，中英双语界面与系统提示词，以及“你好星核” / “Hi Nova”唤醒词。
  - 接入 mem0 / VoiceMem 个人记忆
  - 新增 iPhone 客户端，通过 Tailscale 连接电脑上的 runtime。
- **2026-08-31 · v0.1.0** — 常驻语音、Codex 后台执行、途中补充需求、工作区与会话管理，以及按需播报进度。

## 1. 核心特性

Nova Audio Agent **常驻通用语音 agent**：小诺（Nova）保持前台对话实时响应，同时在后台处理长任务，并在合适的时间汇报合适的进度。

同期工作 [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent) 回答的是
「怎么让 agent 边干活边说话」；我们在此基础上又追问了一层——**开口这件事，什么时候才值得**
（详见[语音交互设计说明](docs/en/blog/2026-08-proactive-voice-agent-design-space.md)）。


- **主动有分寸。** 重要进展及时说，琐碎过程保持安静，提醒不抢用户说话。
- **语音管理工作区。** 创建、切换工作区与会话，由你确认。
- **先问清，再动手。** 需求不明确时先澄清，再交给后台执行。
- **执行中随时调整。** 任务进行中，通过语音补充要求和约束。

## 2. 设计架构

[![Nova Audio Agent 运行时架构](assets/ideas/v3/nova-audio-agent-runtime-chalkboard-zh-CN.png)](assets/ideas/v3/nova-audio-agent-runtime-chalkboard-zh-CN.png)

*一个事件循环，两个模型端口共读一份 ContextView，Memory 当公共黑板，Floor 把守唯一说话通路。*

几个关键角色：

* **FrontBrain：** 实时前台模型，通过最小主机工具面派活、取消、确认主机提案、召回记忆和搜索；revision-bound intake slots 由主机拥有。
* **Surrogate：** 决定**何时开口**。事件写入 Memory 或建议池后，由它判断值不值得告诉用户。
* **Memory 与 ContextView：** Memory 短期、分通道；能力证据与 intake facts 受限编译进 ContextView 给 FrontBrain。
* **Floor：** 说话权。不同事件自带不同优先级。
* **Executor 与 Controller：** role-based manifest 运行异步工作；AgentController registry 拥有面向模型的 controller 及隐藏的 Vision watch/guard。主对话直接向当前 VLM 附图；视觉监控独立管理完整循环。
* **Compressor：** 对话变长后，短期记忆可能撑爆 FrontBrain 和 Surrogate 的上下文，Agent用摘要模型自动压缩。

架构细节见 [架构](docs/en/architecture.md)。



## 核心功能

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Voice Vibe Coding</h3>
      <p>用语音描述功能、调整需求，Codex 在后台编码与测试。关键进展主动告知，琐碎过程保持安静。</p>
      <img src="assets/features/coding.svg" alt="语音需求交给 Codex，完成编码与测试的流程示意" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>理解意图，问清再做</h3>
      <p>自然描述目标，Nova 理解你的意图，问清缺失信息后再开始任务。</p>
      <img src="assets/features/conversation.png" alt="Nova 在开始任务前澄清应用形式与需求" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>用语音管理工作区</h3>
      <p>用语音创建工作区、切换项目或恢复会话，关键变更由你确认。</p>
      <img src="assets/features/workspace.png" alt="Nova 请求确认创建宠物管理系统工作区" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>操作权限，由你决定</h3>
      <p>执行命令或访问网络需要额外权限时，查看请求并选择允许或拒绝。</p>
      <img src="assets/features/permission.png" alt="带允许和拒绝选项的网络访问请求" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>视觉监控与主动提醒</h3>
      <p>告诉 Nova 要关注的画面变化，条件触发时主动提醒。</p>
      <img src="assets/features/vision-camera.png" alt="摄像头观察结果与主动播报" width="100%">
    </td>
    <td width="50%" valign="top">
      <h3>接入工具与知识</h3>
      <p>自由配置 ASR / LLM / TTS 和 MCP，基于自己的资料问答。</p>
      <img src="assets/features/knowledge.png" alt="基于 CN-27 演示资料的知识库回答" width="100%">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>记住与你有关的事</h3>
      <p>mem0 跨对话回忆个人信息，随时查看记忆与原话。</p>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/features/mem0-dark.png">
        <img src="assets/features/mem0.png" alt="mem0 本机记忆及原话入口" width="100%">
      </picture>
    </td>
    <td width="50%" valign="top">
      <h3>把 Nova 带在身边</h3>
      <p>iPhone 通过 Tailscale 连接电脑，随时对话和审批。</p>
      <img src="assets/features/iphone.png" alt="iPhone 主界面与连接设置" width="100%">
    </td>
  </tr>
</table>

<sub>图中使用演示数据，部分截图已抠图、拼接。</sub>

## 3. 快速开始

环境要求：Node.js 22+、npm、Git、已登录的 `codex` 可执行文件（Codex 只走 app-server）

```bash
# 全局安装
npm install --global nova-audio-agent@0.2.3
# 启动客户端；首次启动会弹出设置窗口，填一个 DashScope 密钥即可
novaaudio
# 打开设置面板
novaaudio config
# 查看当前语音管线需要哪些密钥；加 --online 在线验证
novaaudio doctor
```

无头 Ubuntu 22.04+：通过 npm 安装 `nova-audio-agent-server`，完成配置与凭据初始化后运行 `novaaudio-server start`；另开终端运行 `novaaudio-server pair wss://your-host.ts.net` 显示一次性配对二维码。配置见[远程服务指南](docs/zh-CN/deployment/remote-server.md)。

从源码开发时：

```bash
git clone https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
npm ci && cp .env.example .env
# 在 .env 中填入 DASHSCOPE_API_KEY
```

启动桌面应用：
```bash
npm run start:client
```
客户端包含麦克风、摄像头、声音开关等按钮，以及设置面板和外部 MCP 设置。你也可以试试把鼠标悬在桌面 orb 上，会有惊喜）

从 [DashScope](https://platform.qianwenai.com) 获取 API Key 并配置 `DASHSCOPE_API_KEY`。这一把密钥就能用语音、记忆、摄像头和联网搜索；搜索默认走百炼，配置 [Tavily](https://docs.tavily.com) 的 `TAVILY_API_KEY` 后改用 Tavily。

```bash
npm run build --workspace @nova-audio-agent/runtime
node runtime/dist/src/cli.js diagnose --json
node runtime/dist/src/cli.js demo all
```

原生回声消除采集（VoiceProcessingIO）仅 macOS 可用，唤醒检测在可用时复用该采集路径；
Windows、Linux 源码运行及 macOS 回退路径使用 Chromium `getUserMedia` + AudioWorklet。
休眠时麦克风帧仅送入本地唤醒 Worker，闭麦会停止唤醒检测。详见[本地唤醒设置](docs/zh-CN/getting-started.md#本地唤醒词)。

## 4. 文档

| 读这篇 | 目的 |
|---|---|
| [架构](docs/zh-CN/architecture.md) | 模块与边界 |
| [术语与不变量](docs/zh-CN/glossary.md) | 核心常量 |
| [上手指南](docs/zh-CN/getting-started.md) | 安装与集成 |
| [语音助手什么时候该开口？](docs/en/blog/2026-08-proactive-voice-agent-design-space.md) | 语音交互设计 |
| [Node runtime 迁移归档](https://github.com/deepnovacore/NovaAudioAgent/tree/20a0812c0acb83b53cbad4b415d637dafff3c7f6/docs/archs/node-runtime-migration) | `v0.1.0` tag 历史中的迁移期计划 |

## 5. 路线图

- [ ] **v0.3.0：** 将文字与语音整合进主窗口，提供对话、动态、任务和记忆视图；围绕记忆发现需求、提出建议并持续跟进；让个人记忆可追溯、可纠正、可删除；接入用户授权的目录、邮件、日历和飞书会话。
- [ ] **v0.4.0：** 扩展 Kimi Code、pi agent 等 coding 后端；以 AutoGLM 为首个示例接入 GUI 执行器，支持专长 Agent 之间的协作。

发布前须完成功能与支持平台验收。Ubuntu 22.04+ x64 桌面端与无头 npm 包纳入候选发布验收。

## 6. 贡献

```bash
npm ci && npm run check && npm run build && npm test
```

安全问题见 [SECURITY.md](SECURITY.md)，贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 7. 许可证

版权所有 2026 DeepNovaCore，[Apache License 2.0](LICENSE)。
