# 01 多入口与主窗口

> 轨道 B。目标：用户在桌面可以打字、长按说话得到可编辑草稿、或切到全双工语音，三种入口共享
> 同一会话、任务、记忆与授权；主窗口提供 动态 / 任务 / 记忆 三个视图，可以收起为现有语音悬浮窗
> 继续交互。语音不再是唯一入口，但全双工语音的端点检测、打断等实时语义保持不变。

状态：待评审。对应里程碑 M5-B、M6-B。

## 1. 现有基础

- **协议**：`docs/protocols/client-v1.md` "级联可编辑输入"一节。级联主机在 `client.ready.capabilities`
  中声明 `text_input`、`dictation`；`input.text`（≤4000 UTF-16 单元）、`input.dictation`
  （`id` + `start | finish | cancel`，草稿缓冲 16 kHz PCM16 ≤60 秒，finish 调用级联 ASR，30 秒超时）、
  `input.audio`（结束草稿模式，恢复连续语音）；识别结果 `input.transcription`。
  **草稿不是用户轮次，不触发 LLM 或工具；客户端必须显式发送编辑后的 `input.text`。**
- **runtime**：`runtime/src/desktop.ts` 定义上述 payload 的 zod schema；`runtime/src/desktop/desktop-session.ts`
  持有草稿状态机；`runtime/src/server/client-protocol.ts` 仅在 `pipeline_mode = cascaded` 时声明能力；
  `runtime/src/realtime/service.ts` 要求 provider 具备 `transcribeDraft` 能力。
- **管线**：`runtime/src/composition/cascaded-realtime-assembly.ts` 按 `pipeline_mode` 选 `integrated`
  （单一实时语音模型，`runtime/src/realtime/qwen.ts`）或 `cascaded`（端点检测 → ASR → LLM → TTS，
  `runtime/src/realtime/cascaded/`）。
- **客户端接线现状**：桌面 renderer（`clients/desktop/src/renderer/*.mjs`）未接
  `input.text` / `input.dictation`；iOS 的 `Client.swift` 已实现文字发送、长按 dictation 状态机
  与麦克风权限处理（**代码已实现**），但**真机验收未完成**，spec 09 仍标 planning。
- **桌面已有面板**：`task-banner.mjs`（解析 `EXECUTOR_TASKS`：`{revision, active_project,
  tasks[{work_id, executor, project, title, phase, summary, ts}]}`，phase
  `started | working | completed | cancelled | failed | refused | unknown`）、`memory-board.mjs`、
  `knowledge-panel.mjs`、`capabilities-editor.mjs`、进度气泡。
- **状态所有权**：会话、任务、授权、交付的事实来源是主机；桌面已按此约定消费。

### 1.1 Qwen 实时协议文字输入调研（2026-09-10）

问题：integrated 管线能否在同一会话里同时接文字与音频？

- Nova 当前 integrated 默认模型是 `qwen-audio-3.0-realtime-plus`（`runtime/src/config/config.ts`、
  `runtime/src/config/environment-contract.ts`）。`runtime/src/realtime/qwen.ts` 已经在同一会话中
  交替发送 `input_audio_buffer.append` 与 `conversation.item.create`（`input_text` 内容），
  `turn_detection` 在连接时设一次且不再切换。但**现有所有 `input_text` 都是主机注入**
  （工具结果、工作区上下文、进度事实，并明确标注"不是用户说的话"），没有真实用户文字轮次路径。
- Qwen-Audio-Realtime 官方文档（[用户指南](https://help.aliyun.com/en/model-studio/qwen-audio-realtime-user-guides)）
  记载 `conversation.item.create` 支持 `message`（role `system | user | assistant`，含 `input_text`）、
  `function_call`、`function_call_output` 三种 item；未记载禁止文字与音频混用。限制是
  `turn_detection` 只能在发送首段音频前设置，切换交互模式需重连。
- 参考项目 `thirdparty/qwen-audio-agent` 对同一模型系已实现用户文字轮次
  （`server/src/voice/realtime-provider.mjs` 的 `sendUserText`，与音频同会话），并把
  "文字轮次取消进行中的语音轮次"作为其自身 UX 策略。
- Qwen-Omni-Realtime 系（`qwen-omni-turbo-realtime`、`qwen3.5-omni-*-realtime`）的官方
  [客户端事件页](https://www.alibabacloud.com/help/en/model-studio/client-events)记载
  `conversation.item.create` **仅支持 `function_call_output`**，[概览页](https://www.alibabacloud.com/help/en/model-studio/realtime)
  记载音频输入为必需。参考项目文档称 Omni 系也接受文字输入，与官方页面冲突，本次未能核实。

结论：对 Nova 实际使用的 Audio-Realtime 系，**协议层支持带 `input_text` 的 user message**，
置灰不是 provider 协议限制。但以下三件事未经验证，不能概括为"只补能力声明"：
（a）真实用户文字轮次是否稳定触发响应并进入对话历史；（b）文字轮次到达时进行中的语音轮次如何取消，
`smart_turn` 下服务端自动响应与主机 `response.create` 如何关联；（c）主机交付记账在文字轮次下的语义。
若未来切到 Omni 系，文字入口按官方文档不可用。是否为 integrated 补文字入口列为待评审（§4），
不影响 D2"桌面默认 cascaded"。

## 2. 本卷新增

### 2.1 管线默认值

- 桌面默认 `pipeline_mode = cascaded`。文字、草稿、全双工语音共用同一个 LLM 会话。
- integrated 保留为设置中的"纯语音低延迟模式"。选中时：输入框置灰，提示"当前模式只支持语音；
  切换到默认模式可打字"；`client.ready.capabilities` 如实不声明 `text_input` / `dictation`。
- 纯文字使用不初始化麦克风；麦克风在用户首次切到草稿或全双工时申请权限。
- 现有用户若已配置 integrated，升级后不静默改动其设置；首次启动主窗口时提示一次可切换。

### 2.2 输入框三态

同一个控件，三种状态，状态由用户显式切换，主机以能力声明约束可用状态：

| 状态 | 用户动作 | wire 事件 | 何时成为用户轮次 |
|---|---|---|---|
| 打字 | 输入、回车或点发送 | `input.text` | 发送即轮次 |
| 草稿 | 长按录音键，松手 | `input.dictation start` → 二进制 PCM → `finish`；收到 `input.transcription` 后填入输入框可编辑 | 用户点发送才发 `input.text`；识别失败保留已有文字并显示 `recognition_failed` |
| 全双工 | 点击"持续对话"切换 | `input.audio` 恢复连续语音；输入框位置显示实时转写（只读） | 由级联端点检测决定，沿用现有语义 |

- 全双工状态下再点输入框，主机进入草稿或打字模式前先停止连续采音；三态互斥。
- 草稿缓冲、超时、取消、断线语义以 `client-v1.md` 为准，本卷不改。
- 输入框显示的实时转写来自主机；renderer 不自行跑 ASR。

### 2.3 主窗口信息架构

- **左侧**：常驻对话列。显示当前会话的用户输入、Nova 回复、任务卡（"任务已开始：…"）、
  以及来自 feed 的"接着聊"锚点。输入框固定在底部。
- **右侧**：三个 tab。
  - **动态**：渲染 02 卷的 `feed_item` 列表与空状态；用户动作回传（`open / act / snooze / dismiss /
    expand_evidence`）。名称"动态"为工作名称。
  - **任务**：复用 `task-banner.mjs` 的 `EXECUTOR_TASKS` 数据，展开为列表 + 详情（进度、等待用户的决定、
    产物）。任务真相仍以主机为准。
  - **记忆**：渲染 03 卷的 `memory_entry` 列表与可选概览；纠正 / 忘记 / 查看来源回传。
- **设置**：连接与权限（含 04 卷的来源管理）、管线模式、通知阈值；现有 capabilities-editor、
  knowledge-panel、memory-board（诊断）搬入设置或开发者面板。
- 从动态、任务、记忆的条目都可以"接着聊"，把引用带入对话列。

布局分区（左对话 / 右三 tab）已确认；具体视觉设计、尺寸、是否允许拖拽分栏待评审。
不照搬参考产品的名称与页面外观。

### 2.4 收起态：悬浮窗

- 主窗口收起为现有 orb。会话、后台任务、feed 状态全部不变；重新展开从主机恢复。
- orb 上的新事项提示：出现新的 `feed_item` 时显示角标；达到通知阈值的事项以现有进度气泡样式
  显示一条摘要；默认不出声。语音交付仍走 Floor 与 Proactive 选择路径（02 卷 §2.5）。
- 麦克风状态独立于窗口状态。收起不等于允许持续采音；用户在收起前处于打字或草稿态，收起后
  麦克风保持关闭，orb 显示为静音。
- 桌面静音时主动内容仍通过 feed 与文字呈现，不因静音丢失。
- 进程状态在 orb 与主窗口都可见："运行中 / 后台任务 N 个 / 已断开"。主窗口关闭不等于进程退出，
  退出走显式菜单。

### 2.5 共享主机状态

- renderer 不维护第二份权威任务列表、feed 列表或记忆列表；全部从主机订阅并按 `revision` 更新。
- 主窗口与 orb 是同一 renderer 进程的两个视图（或同一主进程的两个窗口，落地时定），
  订阅同一份状态；不存在两份连接。
- iOS 通过 `/client/v1` 消费同样的 `feed_item` / `memory_entry` / `EXECUTOR_TASKS`，
  但本系列不承诺它们在 M6 前实现新视图。

## 3. 不做

- 不新起客户端。
- 不给 integrated 管线加文字入口（列为待评审，见 §5）。
- 不改草稿缓冲、超时等协议参数。
- 不在 renderer 跑 ASR 或任何模型。
- 不做 Windows / Linux 特定布局；跨平台验收沿用 v0.2.0 台账。

## 4. 待评审

| 项 | 选项 | 影响 |
|---|---|---|
| integrated 文字入口 | 不做 / M6 后补（先做 live 验证 §1.1 的 a、b、c，再改主机能力声明、`qwen.ts` 用户文字 item 与取消语义） | 做则纯语音模式也能打字；验证不通过则维持置灰 |
| 主窗口与 orb 的窗口形态 | 同一 BrowserWindow 变形 / 两个 BrowserWindow 共享主进程状态 | 影响动画与 macOS 行为；不影响契约 |
| 视觉布局 | 固定分栏 / 可拖拽 / 右侧可整体折叠 | 只影响 UI |
| 首页名称 | "动态" / 其他 | 只影响文案 |
| 现有 integrated 用户的迁移提示 | 一次性提示 / 不提示 | 影响升级体验 |

## 5. 验收场景

编号沿用讨论稿 §9。

- **1 直接使用**：全新安装，不自我介绍、不连接任何资料，打开主窗口打字交办一件事，任务出现在任务 tab；
  全程不申请麦克风权限。
- **2 切换入口**：文字提交任务后收起窗口；用语音问"那个任务怎么样了"，回答引用同一 `work_id`，
  任务 tab 不新增任务。
- **3 语音草稿**：长按录音、松手，识别文字出现在输入框；修改后发送才生成用户轮次；识别失败时
  输入框原有文字保留并显示失败提示；期间任务 tab 无新任务。
- **11 静音与后台**：静音后后台任务继续；新 `feed_item` 出现在 orb 角标；主窗口关闭后 orb 显示
  "运行中"；退出进程后 orb 消失，重开主窗口能恢复上次 feed 与任务状态。
- **三态互斥**：全双工中点击输入框，连续采音停止，草稿或打字可用；再切回全双工，`input.audio`
  发送且转写恢复。
- **管线切换**：设置切到 integrated，输入框置灰并显示原因，能力声明中无 `text_input`；切回 cascaded 恢复。

## 2026-09-12 修订：多会话工作台

本节以用户确认的工作台方案为准。左侧为会话列表，中间为对话与输入框，右侧按需展开动态、任务和记忆。Nova 不包含代码编辑器、终端或内置 coding agent；执行沿用外挂执行器及其授权边界。

主机持久化会话和消息，每个会话隔离模型历史、未完成工具调用、审批与草稿。多条文字对话可以并行；实时语音全局仅一条，主窗口与 orb 共用语音归属。切换查看会话不转移语音。语音所属会话禁止文字和长按转写，其他会话仍可打字；长按转写需要先明确结束实时语音。

纯文字复用级联模型回复及工具流程，但不启动 ASR、TTS、端点检测或麦克风，文字模型与实时语音模式分别选择。手机端已有输入协议、听写草稿与确认语义优先复用，不复制一个新的聊天后端。主机消息为事实来源，provider 历史只是投影；只在无未决工具和审批的安全边界切换。历史恢复失败或超过预算必须明确报错，不声称无缝切换。

语音事件绑定会话及运行代次。用户转写、AI 生成文本、播放完成和中断分别记录；关闭旧运行态后迟到事件不得写入新会话。结束语音立即释放麦克风及播放，不能因此取消所属会话的后台任务或其他会话的审批。

新增固定「主动提醒」会话。菜单栏图标旁显示其持久化未读消息数；仅当主窗口实际显示到对应消息时确认已读，收起、失焦、停在旧消息或 orb 展示均不清零。同时到达的新消息不被旧确认覆盖。macOS 使用原生菜单栏标题，其他平台使用既有提示信息。

需求卡片的具体行动按钮按稳定事项标识创建或返回专题会话，带入已准备摘要与低信任来源材料。重复点击、重试或回执丢失不得重复创建会话或重复启动首轮。Ask／Plan 模式继续后置。

## 2026-09-21 修订：工作区居中，Nova 为右侧对话栏

本节替代 2026-09-12 修订中的分区描述；会话、语音归属、主动提醒未读语义不变。

- **左侧**：窄图标栏，自上而下 Todos / Ideas / Goals / Feeds / 任务 / Profile，底部为「收起为悬浮球」与「设置」。品牌词保留英文，副标题中文（如「Todos · 待办」）。默认落地 Todos。
- **中间**：工作区。页头固定显示页名、连接状态与后台任务数、对话栏开关；内容区为当前页的卡片列表。「可能想记下」候选与「已记下待办」回执按类型出现在对应页顶部的待确认分组。Todos/Ideas/Goals 的新增表单默认折叠在「添加」按钮后。记忆总览与管理条目作为 Profile 页底部的折叠段「Nova 对你的了解」。
- **右侧**：Nova 对话栏，默认展开、可收起；窗口宽度不足 960px 时改为覆盖式抽屉。头部为会话切换器（主动提醒置顶并带未读角标）；输入框沿用三态协议。Nova 回复以受限 Markdown 渲染（标题、列表、代码块、行内标记、链接），链接经主机校验后在外部浏览器打开，不渲染图片。
- **动态页取消**。每条 `feed_item` 已镜像为主动提醒会话内的 `feed:<id>` 消息，对话栏把它渲染为带「讨论 / 稍后 / 忽略」动作的消息卡；`presented` 回执在卡片首次可见时发送。菜单栏未读数与"仅当消息实际可见才确认已读"的语义不变，且要求对话栏处于展开态。
- **连接与权限迁入设置窗口**：目录来源、邮件/日历连接器、每日简报、主动发现间隔集中在设置窗口的「连接与权限」分类，经 `nova:settings:personal` 白名单桥（仅 `state`、`sources.*`、`connector.*`、`discovery.configure`）访问主机；`state` 只返回来源/连接器/设置/能力投影，不含会话、记忆、feed、life、news。工作台内的「前往设置」可深链到该分类。
- 视觉：`workbench.css` 以 `.workbench` 作用域定义 token，跟随系统深浅色；字号阶梯 11/12/13/15/18，元数据用等宽字体，单一强调色，卡片无阴影、圆角 8px。
