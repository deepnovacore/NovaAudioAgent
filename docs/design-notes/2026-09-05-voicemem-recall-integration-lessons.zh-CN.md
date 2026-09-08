# VoiceMem 接入对 Nova 的启发：召回、上下文与流式时机

日期：2026-09-05。

本文记录本次侧边讨论的结论，供主线程架构设计和实现参考。文中的 Nova 接入方式是建议，不代表已经实现；本文不修改既有架构合同或主线程的功能范围。

## 2026-09-06：后端可替换的接入边界

当前独立 worktree 采用 `runtime/src/memory/personal-memory.ts` 定义 Nova 的个人持久记忆接口，VoiceMem 是首个适配器。`memory__recall` 和 realtime assembly 依赖这个接口，具体后端由 `memory/factory.ts` 构造。

- `open/close` 管理资源；`remember` 成功只代表原始来源已持久保存，可在重启后恢复抽取，不代表记忆已经可检索。墓碑返回 `deleted`，不能复活已删除来源。
- `recall` 返回文本、后端内稳定 ID 与证据引用；分类、归属、日期和相关性分数均可省略。分数仅在同一后端内有意义，不作为跨后端置信度。可选 `contextHits` 表示用于回复适应的上下文；VoiceMem 的左右脑路由和 SQLite/Worker 协议留在适配器内。
- 用户身份由宿主构造时固定；仅接收已被 Nova 接纳的最终用户转写。模型不能选择用户、数据库或把个人记忆升级为执行授权。
- `NOVA_AUDIO_AGENT_MEMORY_BACKEND` 当前支持 `disabled`（默认）和 `voicemem`；`MEMORY_PATH`、`MEMORY_USER_ID` 使用相同前缀。尚未实现 mem0，未知后端立即报错。未来新增适配器及其配置，不改召回和转写接入流程。
- Blackboard、项目历史与 workspace graph 仍各自负责会话因果状态、工作成果和项目关系。替换个人记忆后端不等于迁移历史数据，也不代表已实现回复开始前的偏好注入。

第二个后端必须通过相同契约验收：宿主身份隔离、重复来源幂等、真实持久写入确认、关闭/取消、错误与空结果区分、证据不伪造、结果长度限制。无法直接保证持久写入确认的远端后端，需要适配器先可靠保存来源或等待远端明确确认。

## 1. 最重要的结论

建议给现有 `memory__recall` 增加 VoiceMem 查询来源，复用同一个工具入口。VoiceMem 作为个人事实、偏好、情绪与人格记忆的后端，与会话 blackboard、项目工作历史和 workspace graph 共存。

同时区分三个问题：

1. **查得到：** 通过 `memory__recall` 按需查询长期记忆。
2. **来得及：** 需要在本轮回复开始前使用的记忆，应通过偏好快照或流式预取提前准备。
3. **用得对：** host 校验来源、作用域、时效和响应归属，再把记忆交给模型；个人推断不能覆盖执行事实或授权。

接通查询后端不会自动解决回复前注入。后台查到了记忆，也不等于本轮模型已经读到了它。

## 2. “134 ms”和轮次内检索的正确理解

VoiceMem 论文将 134 ms 称为记忆检索延迟，不是从用户说完到助手发声的完整延迟，也不是记忆抽取、整理和写入时间。README 中 Mem0 的 1,440 ms 是作者实验中的对照结果，不能据此保证任意部署都有相同倍数的提升。

“语音轮次内部流式检索”指在用户说话及短暂停顿期间，根据部分转写提前检索。论文利用语音活动检测（VAD）确认一句话结束时本来就存在的等待窗口，把部分记忆处理与这段等待重叠。

```text
串行：用户说完 → 确认结束 → 查记忆 → 模型生成 → 发声

流式：用户说话／停顿期间 → 提前查记忆
      用户说完 → 确认结束（检索同时完成）→ 模型生成 → 发声
```

能否减少额外等待，取决于中间转写是否及时、查询是否足够快，以及结果能否在模型开始对应回复前交付。接入 Nova 后需要分别测量 embedding、分类、检索、注入确认和完整回复延迟，不能继承上游数字作为验收结果。

## 3. Qwen connector 实际如何接入

本次源码核对基于 QwenAudio/qwen-audio-agent 的 `accf85f38c88d9b845d47116c4f063cb0c12ce64`。

### 3.1 音频没有先等待 VoiceMem

当前接法不是“音频先经过 VoiceMem 检索，再发送给 Qwen Audio Realtime”。音频正常进入 Realtime 对话；长期记忆通过会话快照和工具查询两条路径提供。

VoiceMem 自带的流式预取接口，与 Qwen connector 是否实际连接中间转写并在回复前注入，是两件不同的事。所查 connector 链路没有自动实现后一种接线。

### 3.2 会话上下文中的偏好快照

`MemoryProvider.list()` 提供同步文档快照。`buildFrontendContext()` 将其包装为 `<user_preferences>` 和 `<user_memory>`，随后加入会话 instructions。

这不是针对每个问句做一次语义查询。记忆修改后，gateway 使用 `refreshSession: false` 更新本地上下文缓存，不立即重发 `session.update`；后续会话或自然刷新时才带入新快照。其目的是避免后台学习频繁改变 prompt 前缀。

### 3.3 当前问题的按需语义召回

```text
模型调用 memory(action="read", query="…")
    → memoryService.query()
    → VoiceMem connector 查询
    → 返回 documents + context
    → conversation.item.create(function_call_output, call_id)
    → 等待对话项确认
    → response.create，模型继续回答当前问题
```

检索内容作为工具结果进入模型的对话上下文，并不一定要修改 system instructions。Qwen 中此处的 `memory` 长期记忆工具，与其会话摘要等用途的 `recall` 入口不能混淆。

connector 在同一用户的后台整理尚未完成时会只返回同步文档快照，避免查询排在整理任务之后；因此一次成功的工具返回不一定包含新的语义检索结果。

## 4. “查完只能影响后续”应怎样理解

要区分工具后的续答与用户的下一个回合。

- 用户问“我上次说喜欢什么运动”，模型先调用工具，再根据结果回答。这里的续答仍属于当前问题，记忆有实际价值。
- 如果模型已经生成或播出了答案，后来返回的记忆无法改变已生成或已播放的部分。
- 因此，工具召回能实现“需要时先查再答”，但依赖模型主动调用工具，并增加一次工具往返。
- 若希望偏好和相关历史从本轮第一句话开始生效，就需要在对应回复开始前提供它们。

把原始音频扣住、等待记忆查询后才发送，会增加音频输入延迟。更适合流式交互的思路是音频持续发送、记忆并行查询，在回复开始前完成注入；这要求 host 确实能够控制对应回复的启动时机。

## 5. 与 blackboard、workspace graph 和 recall 的共存方式

| 组件 | 主要职责 | 示例问题 |
|---|---|---|
| 当前 blackboard | 当前会话的对话、观察、进展和因果状态 | “刚才发生了什么？” |
| 项目工作历史 | 跨会话保存真实目标、关键进展、执行结果和证据 | “昨天做到哪了？” |
| Workspace graph | 项目身份、别名、关系与关系证据 | “那个语音项目叫什么？为什么和这个项目有关？” |
| VoiceMem 双脑 | 个人事实、偏好、情绪事件与长期倾向 | “我通常喜欢怎样的解释方式？” |
| memory__recall | 统一查询并交付结果 | 根据问题访问上述来源 |

`memory__recall` 是入口，不需要成为另一个记忆库。增加 VoiceMem 查询渠道，不意味着把其全部内容复制到 blackboard，也不意味着用它替换项目历史或 graph。

建议的来源划分：

```text
memory__recall
    ├─ session：当前 blackboard
    ├─ project：项目工作历史 + workspace graph
    └─ personal：VoiceMem 事实、偏好、情绪与人格记忆
```

可增加可选 `source` 参数，省略时保持原有会话召回行为。现有 `recent/any` 保持时间/搜索窗口语义，不悄悄扩成跨项目权限。上述名称是建议接口，尚非已实现合同。

host 负责把项目指代解析为稳定身份和允许查询的范围。模型不能直接指定任意用户、数据库或路径。同名项目不因语义相似而合并；多个候选无法确定时返回歧义。

例如“继续上次那个语音项目，简单说一下做到哪了”：graph 提供项目候选，工作历史提供进展证据，个人偏好影响表达方式。最终结果保持各自来源和权威，不混成一个没有出处的总结。继续执行仍经过既有项目选择和授权流程。

## 6. 三条上下文路径

| 路径 | 内容 | 使用时机 |
|---|---|---|
| 自动上下文 | 当前项目、少量相关关系、稳定偏好及有效人格提示 | 回复开始前，读取已提交的有界快照 |
| recall 工具结果 | 本次问题需要的具体历史和记忆证据 | 查询结束后，模型续答当前问题 |
| 流式预取缓存 | 基于中间转写提前得到的查询候选 | 校验与最终问题一致后供前两条路径复用 |

预取结果不应一产生就无条件注入。它可以先进入缓存：回复开始前取其中有效部分，或者在模型调用 recall 时直接命中，避免重复查询和重复注入。

中间转写可能变更或反转含义，缓存必须绑定当前会话、回合、查询内容和作用域；最终问题不匹配时重查或放弃。取消和过期结果不能落到另一个问题。预取用于查询已有记忆，不能把不稳定的 partial ASR 当作长期事实保存。

## 7. Nova 的可复用基础与仍需补齐的部分

当前 Nova 已有工具结果到 `function_call_output` 的映射，以及 workspace context 的创建、确认、替换、会话身份和修订检查。串联式 LLM 路径也会在请求构造时读取 workspace context。这些是可借用的交付机制，不代表 VoiceMem 已接入。

个人记忆不能直接塞进工作区专用生命周期：没有当前项目时偏好仍然有用，切项目也不应删除个人偏好。应保持独立的记忆上下文作用域，复用底层交付和确认机制。

原生 Realtime 自动开始回复的时机尤其需要验证。消息发送成功、Provider 确认收到、模型在对应回复开始前读到，是不同层次的证据；不能以第一项替代最后一项。

统一工具入口也不要求把所有查询都串行等待。保留原会话召回的轻量路径；长期查询走异步工具生命周期。自动上下文不在同步构造期间临时等待远端 embedding 或模型分类。

## 8. 实现经验与验证要点

建议先接通 VoiceMem 的 recall 来源，形成“当前问题 → 查询 → 工具结果 → 当前续答”的真实闭环；稳定偏好通过自动快照生效，流式预取再复用同一查询逻辑。这个顺序只针对接入，不缩减主线程要求的 VoiceMem 功能范围。

需要验证的用户可见行为：

1. 模型对当前问题先查再答，不能在结果返回前编造历史。
2. 相关偏好在本轮第一句话生效；无当前项目时个人记忆仍可使用。
3. graph 找项目，工作历史查进展，个人偏好调表达；三者不发生事实或权限混淆。
4. 预取命中可减少 recall 等待；问句改写、切项目、取消后旧结果不会注入。
5. 已开始生成时才返回的记忆，不被宣称影响了本轮开头。
6. 检索不可用、只有旧快照、返回截断与确实无命中可以区分。
7. 删除或纠正记忆后，旧快照与预取缓存失效，不继续影响回复。

## 来源与代码入口

- [VoiceMem 论文：流式检索与延迟](https://arxiv.org/html/2608.26005v1#S3.SS3)
- [VoiceMem 流式接口](https://github.com/xzf-thu/VoiceMem/blob/main/voicemem/stream.py)（本次读取 main，后续可能变化）
- [Qwen 上下文构造](https://github.com/QwenAudio/qwen-audio-agent/blob/accf85f38c88d9b845d47116c4f063cb0c12ce64/server/src/conversation/frontend-agent-context.mjs)
- [Qwen gateway 快照刷新与观察接线](https://github.com/QwenAudio/qwen-audio-agent/blob/accf85f38c88d9b845d47116c4f063cb0c12ce64/server/src/voice/realtime-gateway.mjs)
- [Qwen VoiceMem connector](https://github.com/QwenAudio/qwen-audio-agent/blob/accf85f38c88d9b845d47116c4f063cb0c12ce64/server/src/conversation/providers/voicemem/voicemem-provider.mjs)
- [Qwen memory 工具执行](https://github.com/QwenAudio/qwen-audio-agent/blob/accf85f38c88d9b845d47116c4f063cb0c12ce64/server/src/voice/tools/tool-call-handler.mjs)
- [Qwen 工具结果交付](https://github.com/QwenAudio/qwen-audio-agent/blob/accf85f38c88d9b845d47116c4f063cb0c12ce64/server/src/voice/realtime-provider.mjs)
- Nova 本次检查入口：`runtime/src/realtime/qwen.ts`、`runtime/src/realtime/provider-session.ts`、`runtime/src/realtime-assembly.ts`、`runtime/src/realtime/cascaded/qwen-llm.ts`。本地工作区由主线程持续修改，实施时需重新核实。
