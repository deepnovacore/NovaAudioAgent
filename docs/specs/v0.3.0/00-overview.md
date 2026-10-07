# Nova Audio Agent v0.3.0 Spec Series

> 状态（2026-10-07）：v0.3.0 已发布。本系列是设计记录；各卷中「规划」「尚未实施」等标注反映撰写当时的状态，
> 实际行为以代码和 [用户文档](../../zh-CN/README.md) 为准。

> 摘要：v0.3.0 是一次产品定位转型。Nova 从"语音优先、开口让 Codex 干活"的桌面助手，
> 转为**拥有持续记忆、能发现潜在需求并跟进事情的通用个人 Agent**：用户可以打字、说话，
> 也可以让它在后台工作。本系列锚定三件事——交互（含 push-and-pull 主动交互与需求发现）、
> 记忆、前后脑协作——并把语音降为入口之一。系列只定边界与验收；实现按里程碑推进，
> 里程碑从 M5 续编号，双轨并行、各自小步。**2026-09-11 已授权按 M5–M7 实施。2026-09-12 决定：M8 邮件 / 日历与飞书 IM
> 留在 v0.3.0（M8-Mail、M8-IM），推翻 09-11 移至 v0.4.0 的划分；M9 执行器仍在 v0.4.0。**
>
> 起点：产品定位与架构设计讨论稿（2026-09-10，已不在仓库）。
> 本系列吸收其结论并把脑暴敲定的决策写成契约；讨论稿保留为背景和参考来源。

This series is the product and engineering contract for the next minor line after
`v0.2.0`. Each volume owns one boundary. Implementation plans and code land only
after the corresponding volume is agreed. The public architecture volumes under
[`docs/en/archs/`](../../en/archs/00-overview.md) remain the source of invariants; specs
here propose deltas and never silently rewrite those volumes.

| Volume | Topic | 轨道 |
|---|---|---|
| [01 多入口与主窗口](01-multi-entry-and-main-window.md) | 文字 / 全双工语音 / 长按草稿共用一个输入框；主窗口从现有桌面长出，悬浮窗为收起态；共享主机状态 | B |
| [02 需求发现与动态页](02-need-discovery-and-feed.md) | 扩展 Proactive 输出 proposal；低频检查；主机校验、入池、去重、交付记账；`feed_item` 契约 | A |
| [03 用户视角记忆](03-user-memory-view.md) | `memory_entry` 投影；来源、stated/inferred；纠正与忘记的回写与传播；概览段落的覆盖声明 | A 与 B 交界 |
| [04 来源与 connector](04-sources-and-connectors.md) | 用户配置的本地目录；一个邮件/日历 provider；飞书 IM 作为来源与投递渠道；授权、暂停、断开、删除；MCP 作为暴露方式 | C |
| [06 记忆底座](06-memory-substrate.md) | 账本 / 条目 / 视图三阶段；`evidence_record` 与 `entry_revision` 契约；merge 唯一写入口；Discovery 拆为抽取与筛选 | A 与 C 交界 |
| [07 Memory、信息渠道与交互（设计稿）](07-memory-channels-and-interaction.md) | A 留 SQLite、B／C Markdown + Git 权威；混合整理节奏；mem0 不进写路径；文本／语音／IM 读取策略；现状、差距及验收边界 | 共同，待评审 |

2026-09-21 新增 07 卷并于同日脑暴收敛为设计稿：理解层（B／C）以 Markdown + Git 为权威、原文账本留 SQLite；整理节奏为逐条入库加每日批量；mem0 不进写路径；飞书私聊纳入文本入口。D8 已追加对应修订；各卷实施契约待评审后另立计划，不代表功能已经实现。

补充 review：07 卷已加入黑板报及 [§9 架构评审](07-memory-channels-and-interaction.md)，聚焦事实与摘要、来源生命周期、访问范围、写入恢复和读取预算；均为待讨论建议。

## 本版范围（2026-09-11，2026-09-12 调整）

1. M5：桌面文字/语音入口和有依据的 proposal 闭环。（已实现）
2. M6：持久动态、用户可纠正/忘记的记忆。（已实现）
3. M7：用户授权的本地目录增量来源。（已实现）
4. 记忆底座：06 卷三阶段底座，收敛现有三套记忆。（规划）
5. M8-Mail：一个邮件/日历 provider；M8-IM：飞书连接器，既是来源也是提醒投递渠道。（规划，2026-09-12 从 v0.4.0 拉回）

M9-C Kimi Code / pi agent、M9-G GUI/AutoGLM、M9-Demo 仍在 [v0.4.0](../v0.4.0/00-overview.md)。编号和验收边界不变。

## 与 v0.2.0 的关系

- v0.2.0 的收尾项（真人语音验收、Windows 安装包与唤醒词验收、
  v0.2.0 RELEASE-GATE）留在原处，不并入本系列，也不因本系列而降级。
- v0.2.0 定义的基础边界继续有效（具体完成度以其验收台账为准）：六工具 FrontBrain 面、执行器端口与角色路由、主机拥有的确认、
  能力注册表与 MCP、本地知识库、进度气泡、本地唤醒词、级联宿主调度。本系列在其上加层，不重写。
- 分支策略沿用：dev 分支通过自动化门禁即可集成；合入 `main` 需要本系列各卷的验收台账，
  台账在 M5 开工时另建，本系列不预先声明。

## 已定决策（2026-09-10 脑暴）

以下决策已经与产品负责人确认，是各卷的前提。修改任何一条需要回到本节并记录理由。

| # | 决策 | 理由 |
|---|---|---|
| D1 | **两条轨道并行、各自小步。** A 轨：需求发现闭环；B 轨：主窗口与多入口。开工前先钉住两个契约对象（D6）。 | 需求发现能在现有悬浮窗和 iOS 输入框上先验证价值；主窗口若先做而动态页为空，只是一个壳。并行但先定接口，避免互相等待。 |
| D2 | **桌面默认 cascaded 管线。** 文字与语音共用同一个 LLM 会话；integrated（Qwen 实时语音对语音）保留为可选的纯语音低延迟模式。选中 integrated 时文字输入置灰并说明原因。 | runtime 中 `text_input` / `dictation` 只在 cascaded 主机上声明；单一会话让切换入口时上下文天然连续，文字不依赖麦克风初始化。调研表明 Nova 实际使用的 Qwen-Audio-Realtime 系官方文档支持带 `input_text` 的 user message，所以 integrated 置灰**不是 provider 协议层限制**；但完整用户文字轮次、与进行中语音轮次的取消关系、交付语义都未验证，不能概括为只补能力声明。是否为 integrated 补文字入口列为 01 卷待评审项，不影响本决策。 |
| D3 | **记忆页以结构化条目为主，概览可选。** 每条含来源、时间、"你说过"还是"我推断"，可纠正可忘记。页首概览段落必须声明依据条数与来源范围。 | 结构化条目便于审计，纠正有明确落点；叙事画像容易出现"目录名变身份"的过度推断，且改一句要重生成整段。 |
| D4 | **主窗口从现有 Electron 桌面长出，悬浮窗为收起态。** 不新起客户端。信息架构：左侧常驻对话列，右侧 动态 / 任务 / 记忆 三个 tab；具体视觉布局待评审。 | 桌面 renderer 已有 memory-board、task-banner、knowledge-panel、capabilities-editor 可搬入；同进程同状态最容易满足"收起不丢会话与任务"。 |
| D5 | **同一个输入框三态**：打字；长按录音，松手得到可编辑草稿，发送才算一轮；切到全双工，麦克风常开，输入框位置显示实时转写。 | 三种入口在协议上已分别对应 `input.text`、`input.dictation`、`input.audio`；UI 上收敛为一个控件，用户不用理解管线。 |
| D6 | **两个主机拥有的契约对象**：`feed_item`（首页事项）与 `memory_entry`（用户视角的记忆投影，不是新存储）。UI 不持有任何权威副本。 | 它们是 A 轨与 B 轨的接口。A 轨产出并维护，B 轨渲染并回传用户动作。任务列表沿用已有的 `EXECUTOR_TASKS`。 |
| D7 | **新开 v0.3.0 系列，里程碑从 M5 续编号。** | 定位转型在版本号上可见；v0.2.0 的"一句话目标"不被稀释。 |
| D8 | **记忆收敛为一套三阶段底座（2026-09-12）。** A 账本只追加并**存原文**，用户删除来源数据时物理删除；B 条目是只追加的修订日志，merge 是唯一写入口，用户纠正与模型合并是同一种修订记录；C 视图只读重算，统一回忆融合 B 当前态与 A 原文索引；Knowledge 退为索引并继承外发同意。VoiceMem 与 历史工作区存储 改为写入方。Discovery 拆为入库抽取与 tick 筛选。飞书 IM 与邮件都在本版范围（M8-IM、M8-Mail）。 | 三套互不打通的记忆无法满足 D3 / D6 要求的逐条 ID、版本、纠正传播；按参考项目分层会加剧分散。可追溯是属性不是层。存原文换来重抽取能力，代价是字段级敏感策略、物理删除与保留期成为硬要求。详见 [06 卷](06-memory-substrate.md) 与 对照记录（已不在仓库）。**2026-09-21 修订：** B／C 权威表示改为 Markdown + Git，A 仍为 SQLite；merge 唯一写入口不变。详见 [07 卷](07-memory-channels-and-interaction.md)。 |

## Goals

1. **不介绍、不连接也能开始。** 打开 Nova 就能打字或说话交办事情。连接资料是可选增强，不是门槛。
2. **入口切换不换助手、不丢事情。** 文字提交任务后收起窗口，用语音继续问同一任务，不重复创建工作。
3. **有依据的主动发现。** 需求来自对话、任务变化、获准访问的资料和个人记忆；每条建议能追溯依据；没有依据时保持沉默。无任务时也能基于记忆主动关心。
4. **记忆可见、可纠正、可忘记。** 用户看到的是带来源和时间的理解，纠正后检索和未交付建议都看到新状态。
5. **来源由用户授权、范围可见。** 用户自己选目录、账户和范围；覆盖范围、解析失败与同步状态对用户可见。本版来源包括本地目录、一个邮件 / 日历 provider 和飞书 IM；飞书同时是主动提议的投递渠道。
6. **保留执行器基础。** 本版继续使用 Codex；新 coding/GUI 后端在 v0.4.0 验收。

## Non-goals (v0.3.0)

- 全盘无差别采集、默认持续屏幕录制、独立训练的需求模型、复杂习惯预测系统。
- 通用 workflow / graph 平台、多 Agent 编排平台、通用事件总线。
- 电脑关机后仍持续运行的常驻服务器承诺；跨设备身份与同步方案（见"部署边界"）。
- 一次建成插件市场。Kimi Code、pi agent 与 AutoGLM 移至 v0.4.0；Home Assistant 留作后续扩展。
- 组织专属能力进入公共分支。它们不在公共树内，公共边界由
  `runtime/test/public-client-boundary.test.ts` 强制。
- 重写文档解析或检索系统。持续来源管理在现有知识导入与检索能力外围补齐。
- 语义去重或 exactly-once 交付承诺。第一阶段只承诺同用户、同作用域、同稳定依据在同一本地日期内限制重复机会。
- 版本号 bump 或发布切分。`package.json` 保持当前版本直到显式的 release chore。

## 两条轨道与里程碑顺序

```text
M5-B 文字入桌面 ──┐                          ┌── M6-B 动态页
                  ├── 契约 feed_item /       │
M5-A proposal 闭环 ┘   memory_entry 钉住 ────┼── M6-A 记忆页 ──── 记忆底座（06 卷 A/B/C）
                                              │                        │
                                              └── M7 本地目录来源 ──────┼─ M8-Mail 邮件/日历
                                                                       └─ M8-IM 飞书
```

- **M5-A 与 M5-B 互不依赖，可同时开工。** M5-A 在现有悬浮窗和 iOS 输入框上验证；M5-B 只做输入框三态接线和主窗口骨架（对话列 + 复用 task-banner 的任务 tab）。
- **M6 两项都依赖契约对象先在 02、03 卷钉住并有 fixtures**，以及 03 卷 §2.1 的 personal-memory
  端口扩展（`list` / `get` / `correct` / `forgetEntry`）与 02 卷的持久化交付 / 忽略台账先落地。契约字段在 02（`feed_item`）和 03（`memory_entry`）给出完整表；本卷只给概念定义。
- **M7 起属于 C 轨（来源）**，依赖 M6-A 的记忆回写路径（来源删除要传播到记忆与 feed）。
- **记忆底座**在 M6-A 已实现的 VoiceMem 路径之上收敛：06 卷 schema 与 fixtures，历史工作区存储 作为第一写入方迁入，VoiceMem 迁移路径待评审。
- **M8-Mail 与 M8-IM 并行**，都依赖 M7 的来源管理路径与记忆底座（来源删除要物理删除账本行）；先上哪个真实账号验收待评审。
- 不写日期。每个里程碑只写依赖与退出条件。

## 契约对象（概念定义）

| 对象 | 回答的问题 | 拥有者 | 完整字段 |
|---|---|---|---|
| `feed_item` | 用户现在需要看见和处理什么 | 主机；由 Suggestion Pool 的准入结果生成和更新 | [02 卷](02-need-discovery-and-feed.md) |
| `memory_entry` | Nova 对用户形成了什么理解，依据是什么 | 主机；是 personal-memory 端口之上的投影，目标为 06 卷底座当前态 | [03 卷](03-user-memory-view.md) |
| `evidence_record` | 实际读到了什么、从哪来、什么时候 | 主机；账本行，只追加，存原文 | [06 卷](06-memory-substrate.md) |
| `entry_revision` | 一条理解的某次修订：谁写的、依据什么、替代了哪次 | 主机；只经 merge 写入 | [06 卷](06-memory-substrate.md) |

两者都是**接口内容，不是已发布的 wire schema**。落地时以 zod schema 与 `tests/fixtures/` 下的
golden 向量钉住，沿用 [client-v1](../../en/protocols/client-v1.md) 的 `client.command` /
`client.command_result` 承载方式。UI 不维护权威副本；重新打开界面从主机恢复。

来源记录、个人记忆、proposal / suggestion、任务、首页事项五种对象的职责分工沿用讨论稿
§5.2，本系列不重复定义。

## 现有基础（2026-09-10 核实）

各卷"现有基础"小节只陈述以下已核实事实，并给出文件路径；未核实的能力一律写为"待验证"。

- **文字输入**：`runtime/src/desktop.ts` 定义 `input.text`（≤4000 UTF-16 单元）与
  `input.dictation`（start/finish/cancel，≤60 秒 16 kHz PCM16 草稿缓冲，30 秒 ASR 超时）；
  `runtime/src/desktop/desktop-session.ts` 持有草稿状态机；`runtime/src/server/client-protocol.ts` 仅在 cascaded
  主机上声明 `text_input` / `dictation`。桌面 renderer 未接线；iOS 的
  `clients/ios/Nova/Nova/Connection/Client.swift` 已实现文字发送与 dictation 状态机（代码已实现），
  真机验收未完成。
- **主动机制**：`runtime/src/core/suggestions.ts`（`SuggestionPool`；kind `question | notify | followup`；
  status `pending | fired | withdrawn | expired`；`evidence_refs`、`expires_at`、`cooldown_until`、
  `delivery_policy`）→ Proactive（`runtime/src/model/prompting.ts` 的 `SURROGATE_SYSTEM`，只选择不生成、
  不调用工具；输出契约 `speak / suggestion_id / progress_class / reason` 在 `runtime/src/core/ports.ts`
  与 `runtime/src/model/proactivity.ts`）→ `runtime/src/realtime/floor.ts` 仲裁 allow / preempt / defer。
  runtime 有黑板维护等内部定时器，但**没有用于需求发现的低频检查**；主动行为全部由执行器进度与
  观察事件触发。
- **记忆**：`runtime/src/core/memory.ts`、`runtime/src/core/context-view.ts`（唯一面向模型的有界投影）、
  `runtime/src/memory/personal-memory.ts`
  （`PersonalMemoryResource`：`recall`，可选 `remember` / `forget`；只接受可信轮次级写入）、
  `runtime/src/memory/factory.ts`（VoiceMem 后端）。`forget` 按来源粒度；recall 命中没有逐条稳定 ID、
  版本或 stated / inferred 标记；没有列表接口。**没有用户画像层**。桌面 `memory-board.mjs`
  是面向开发者的通道 / 诊断 / 图视图。
- **知识库**：`runtime/src/knowledge/service.ts` 做有界的文件、URL、文件夹导入与混合检索，
  不是持续同步服务。
- **能力与 MCP**：`runtime/src/config/capability-registry.ts`（`capabilities.json`，模块开关，按消费者暴露）、
  `runtime/src/executors/mcp-client.ts`（stdio 与 streamable-http，≤8 外部 server，≤32 工具/server）。
  Home Assistant、AutoGLM 在源码中不存在；`thirdparty/Open-AutoGLM` 仅为参考副本，未被引用。
- **客户端**：桌面为 Electron（`clients/desktop/src/main/*.mjs`、`clients/desktop/src/renderer/*.mjs`，
  含 `task-banner.mjs` 解析 `EXECUTOR_TASKS`）；iOS 为 SwiftUI；
  没有统一客户端 SDK，靠 `docs/protocols/client-v1.md` 与 `tests/fixtures/client-protocol/v1/` 保持一致。

## 部署边界

沿用讨论稿 §10：首版以**本地主机运行**为默认假设。主窗口收起时后台继续工作；应用进程退出、
机器休眠或离线时不承诺持续发现，恢复后补同步与检查。UI 必须明确显示运行状态，"主窗口关闭"
不等同于"进程仍常驻"。若产品要承诺关机后仍持续运行，需要另立常驻服务器与跨设备权限、身份、
同步方案，不在本系列范围。云端模型处理与本地存储分别说明。

## Invariants that must not regress

- FrontBrain 前台工具面不因本系列扩大；新增能力通过执行器端口、直接 MCP 或主机内部路径接入。
- Proactive 只决定"是否值得开口、选哪条"，可以提出 proposal，但不生成给用户听的话、不调用工具、
  不扩大自身权限或提高打扰等级。
- 外部内容（文件正文、邮件、日历、MCP 返回）始终是低信任证据，不是系统指令，也不是用户授权。
- 推断不升级为授权。记忆里的"用户可能想要"不能触发任何写操作或执行。
- 主机是任务、授权、交付的唯一事实来源。"已开始""执行完成""结果已验证""已向用户呈现"是不同事实，
  UI 不得合并。
- 凭据只由主机管理，模型和 renderer 不获得原始 token。
- 公共分支不包含组织专属工作流、内部服务与数据。

## Verification posture

- 每卷末尾列出验收场景，编号沿用讨论稿 §9 的 1–11，便于交叉引用。
- 需求发现同时观察命中与遗漏：固定案例集包含"应提出建议"和"应保持沉默"两类，任何改动都要跑全集。
- 交付记账分展示、通知、语音、IM 四类分别记录；卡片渲染不等于用户已读，bot 发送成功也不等于。
- 默认保留本地诊断；不以收集私人原文作为遥测前提。
- 真人语音、真实目录、真实邮箱的验收另立台账，代码与确定性测试通过不等于验收完成。

## Document conventions

- 中文为主，术语沿用项目约定：主动交互用 push-and-pull；抢占用 Floor / priority / preempt / defer；
  用 executor 不用 lane；watch 相关名称不改。
- 每卷分"现有基础 / 本卷新增 / 待评审"三类陈述。待评审项写成"选项 X / Y，影响 Z"，不写 TBD。
- 契约字段一律 snake_case，与现有 zod schema 约定一致。
