<a id="术语与不变式"></a>
<a id="不变式"></a>
<a id="glossary-and-invariants"></a>
# 术语与设计约束

## 术语表

| 术语 | 含义 |
|---|---|
| FastBrain | 面向用户的推理路径的历史名称；实时实现中这一角色由 FrontBrain 承担 |
| FrontBrain | 语音链路上承担 FastBrain 职责的实时模型 |
| Proactive | 主动沟通：发现有依据的建议并选择值得告知的信息；不执行任务，不控制话轮 |
| Runtime spine | 运行时事件循环，按事件顺序更新状态并协调各项工作 |
| Memory | 按通道记录观测、已接受的执行结果，以及绑定需求修订号的 intake 状态 |
| Personal memory | 跨会话事实，默认保存在本地统一记忆账本中；mem0 仍是可显式选择的替代方案；不具备执行权限 |
| Knowledge corpus（K） | 用户主动开启并单独准入的文档，通过 Knowledge MCP 检索；存储与个人记忆分开；把文档内容发送给云端向量模型前，必须明确告知用户并取得同意 |
| Saved / applied | 已持久化的配置与后端已激活的配置之间的区别；服务类改动可以保存，但需重启后才生效 |
| Channel | 每个能力一条只追加的观测流：`conversation`、`search`、摄像头证据、隐藏的 Vision `watch`/`guard`，以及每个活跃 executor 各一条 |
| ContextView | 为一次模型调用整理的上下文快照，内容与长度均受限制 |
| Floor | 发言仲裁，给出三种判定：`allow`、`preempt`、`defer` |
| Priority | 绑定在触发事件上的紧急度，从不由模型选择：用户 100，guard 90，活跃 executor 50，环境观测 40 |
| Preempt | Floor 判定之一：在允许时打断 Nova 的播放；从不打断用户说话，真正的音频取消只存在于实时通路 |
| Defer | Floor 判定之一：把该语句送入建议池，而不是丢弃 |
| Executor | 由能力清单声明、通过统一接口调用的执行模块 |
| AgentController | 宿主注册表中的条目，描述一个面向模型的 controller 及其拥有的隐藏通道；与 executor manifest 相互独立 |
| Direct MCP tool | 按各使用方的工具白名单提供的 `${name}__${op}` 操作，既不是 executor 的派发目标，也不写入 intake |
| Delegate | 一项带唯一标识的已分派任务；长期编码任务与有界的审批/模型请求各自有独立生命周期 |
| Progress | 绑定到所属 delegate 的执行器尚未结束时发出的进度事件 |
| Observation | 活跃 delegate 在常规进度更新之外上报的观察结果，任务仍可继续（例如一次监控命中） |
| Handoff | 执行器返回给运行时的结构化最终结果 |
| Suggestion | 一条待评估的提醒建议，保存后不一定会向用户播报 |
| Suggestion pool | 建议的生命周期：`pending → fired → cooldown + re-arm → pending`，另有 `withdrawn` 与惰性过期；重新激活需要冷却时间已过，且被引用通道上出现新证据 |
| Steering | 向正在执行的 Codex 轮次追加新指令（经 app-server 传输调用 `codex.steer`），不终止也不重启该轮次 |
| App-server | 由实时 Codex 后端驱动的原生 `codex app-server` JSON-RPC 进程（`turn/start`、`turn/steer`） |
| Wake reason | 记录模型调用的触发原因、来源与优先级；与声学唤醒词不同 |
| Wake word | 本地检测的语音关键词，用于唤醒隐藏的桌面悬浮球；不构成执行授权 |
| Auto-hide / sleep | 桌面空闲状态：隐藏桌面悬浮球，并将未静音的麦克风帧交给本地唤醒检测 |
| Frontend instructions | 宿主在 `frontend-instructions.ts` 中统一渲染的上下文，以及发言和工具使用规则 |
| Response origin | 将一次响应关联到某个用户轮次或宿主请求的提供方证据；不是执行许可 |
| Workspace | 一个隔离的文件系统/Git 项目，拥有自己的 Codex home；Session 从不离开其 Workspace |
| Session | 恰好位于一个 Workspace 内的一条持久、可恢复的 Codex 线程 |
| Proposal / structured confirmation | 创建、切换和恢复操作先产生 proposal；只有携带精确 proposal ID 与 JSON 布尔值的专用确认调用才会提交；拒绝确认、标识不匹配或重复提交时，均不执行操作 |
| Work order | 交给 Codex 的单一、整合且有界的任务陈述；会话历史从不越过这条边界 |
| Pipeline mode | 实时链路的顶层形态：`integrated`（单个实时模型）或 `cascaded`（端点检测 → ASR → LLM → TTS） |
| Endpointing | cascaded 模式下判断一句话是否结束的阶段（语义轮次检测器，或有界静音） |
| Knowledge MCP | 内置的 `mcp__nova_knowledge__recall` 证据工具；可选的 Codex 回环还会通过 `get_chunk` 解析通过内容摘要标识并校验的分块，从不修改语料库 |
| MyContext adapter | 可选的回环专用、只读证据提供方，位于 Nova 的严格能力握手之后；本仓库不附带任何 adapter |
| Workbench | 桌面主窗口：左侧是图标导航栏，中间是个人对象页面，Nova 以可收起的对话栏出现在右侧 |
| Rail | Workbench 左侧的图标导航栏，用于切换 Todos、Ideas、Goals、Feeds、Task 和 Profile |
| Task | 由宿主持久跟踪的委派工作单元，带有目标与验收标准；与临时的 executor delegate 不同 |
| Handback / takeover | 在 Nova 与用户之间转移 Task 的控制权：takeover 后用户可直接向执行器发消息，Nova 暂停自动修正；handback 后控制权交还给 Nova |
| Acceptance criterion | Task 的目标必须满足的一条陈述，Nova 才能将其标记为完成；每条标准分别记录证据 |
| Candidate | Nova 在对话中留意到、尚未确认的 Todo、Idea、Goal 或 Profile 候选内容，在用户确认后记录；明确说出的待办会直接记下，可以撤销 |
| Source | 个人记忆与建议可以引用的、已获授权的文档、账号或信息流 |
| Connector | 通过用户授予的只读范围暴露某个 Source 的集成（例如 Google、macOS 日历、Apple Mail 或飞书） |

## 必须保持的约束

<a id="invariants"></a>
1. Runtime 不在事件循环主体中等待 executor 完成。
2. Executor 从不直接对用户说话。
3. 任何被接受的结果都先写入 memory，之后才影响对话。
4. 绑定需求修订号的 intake 状态是唯一的任务规划状态；只有宿主授权 FSM 能授权产生实际效果，任何模型都不能写入授权。
5. 模型看到的是有界 ContextView，绝不是不受限的 memory。
6. Delegate 的身份与操作必须和 progress、终态事件一致。
7. 终态完成至多被接受一次。
8. 用户等待的工作不依赖 Proactive 来交付。
9. 环境建议不能绕过 Proactive 和 Floor。
10. 外部文本和图片按证据处理，不按指令处理。
11. 只有配置过的 manifest 才会成为面向模型的工具。
12. 日志和配置错误中不含密钥值。
13. 发言优先级绑定在触发事件上；模型不能自行提升优先级。
