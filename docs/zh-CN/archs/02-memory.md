<a id="2-记忆"></a>
<a id="独立的文档知识库k"></a>
# 记忆

Nova 的记忆分为若干层，分别承担会话状态恢复、跨对话记忆和文档检索，数据来源与权限边界各不相同。

<a id="2-memory"></a>

## 分层

<a id="layers"></a>

- **L0——会话运行状态。** `Memory` 频道、已分派的执行任务、已接受的交接，以及绑定当前需求修订号的收集状态，共同构成会话的当前状态，以运行时状态为准。宿主的授权与项目确认状态机属于宿主自身的状态，模型不能把它们当作可写的规划状态。黑板条目会记录时间、信任级别、优先级、结果和证据引用，状态按事件顺序更新，响应只能基于已生效的事件。当前任务和执行器状态只能由运行时更新。
- **个人记忆。** 本地统一账本默认开启，沿用 voicemem 配置名称；也可显式选择 mem0、宿主管控的远程连接或关闭记忆。先保存来源，再异步提取其中的事实，让有用信息跨对话保留。检索、由宿主发起的删除和可选的查看功能都不依赖实时任务状态。配置方式、模型数据流向以及当前桌面视图的限制见[个人记忆](../personal-memory.md)。

## 会话恢复存储

<a id="session-recovery-store"></a>

L0 黑板由专用 SQLite Worker 持久化（`runtime/src/memory/blackboard-session.ts`、`blackboard-store.ts`、`blackboard-worker.ts`），因此对话能跨重启保留。保留量受三个彼此独立的限制约束：条目存活 7 天、最多 1000 条、最多 8MB，超限时先丢弃最旧的条目。数据库路径由 `BLACKBOARD_PATH` 指定（默认 `~/.nova-audio-agent/blackboard.sqlite`），并按 `BLACKBOARD_OWNER_ID` 区分归属。

该存储只负责恢复会话历史，不是可查询的长期记忆，不受限制的长期记忆检索仍被推迟（[设计约束](07-decision-record.md)）。

## 个人记忆引擎

<a id="personal-memory-engines"></a>

三个引擎通过统一接口接入（`runtime/src/memory/personal-memory.ts`），由 `MEMORY_CONNECTION` 和 `MEMORY_PROVIDER` 选择；记忆关闭时，`factory.ts` 返回 `undefined`，不会分配任何存储。

**mem0（显式选择的替代引擎）** 会先把来源写入自身账本，再让模型看到它们。每个来源在 `pending → learned` 之间流转，被删除时变为 `forgotten`；`recall()` 只返回 `learned` 的来源，并在异步抽取调用之后再次检查状态，避免在用户同时删除记忆时返回已经失效的内容。待学习记录在后台异步处理，通过互斥锁保证只有一个进程执行抽取（`learning-lock.db`，`PRAGMA busy_timeout=0`），第二个进程会快速失败，而不会重复同样的工作。同一来源重复提交不会重复入库。存储按用户隔离：`memory.sqlite.mem0/<sha256(userId)>/`，其中 `ledger.db` 与 mem0 SDK 自带的向量数据库放在一起。

**统一本地账本（默认）** 由生产组装接入 `runtime/src/memory-substrate/`，保存来源原文、修订历史与处理同意，并提供统一检索。旧 VoiceMem 数据可只读迁入，原数据库保留。`voicemem` 名称继续用于配置兼容；`factory.ts` 仍保留旧适配器。**远程个人记忆**（`remote-personal-memory.ts`）是宿主管控的 HTTP 客户端，对接 `/v1/remember`、`/v1/forget`、`/v1/recall` 和 `/v1/preferences`；URL 必须是 HTTPS 或回环地址，响应体有大小上限。

显式切换到 mem0 或远程记忆不会迁移统一账本数据；旧 VoiceMem 的只读迁入是独立迁移路径。

## 独立的文档知识（K）

<a id="separate-document-knowledge-k"></a>

可选开启的知识语料与实时对话、个人记忆相互独立。SQLite Worker 存放用户主动提交的文档、分块和向量；关键词检索与向量余弦相似度的排名通过倒数排名融合（RRF）合并。词法检索在支持时使用 FTS5，否则退化为有界参数化 LIKE（Node 22.13 也走这条路径）；条件允许时，打开数据库会依据数据库中的原始分块重建 FTS。

入库和重建索引只能由宿主发起，并且需要用户在设置面板中同意数据外发。文本会发往配置好的 向量模型服务；数据保存在本地，不代表推理也在本地。

FrontBrain 只能看到 `mcp__nova_knowledge__recall`。可选的身份认证回环 MCP 会为 Codex 额外提供 `get_chunk`；工单引用由宿主附加、有长度上限，并会重新校验。公开结果会隐去私有来源路径，并始终为 `untrusted_external`。关闭该模块后不会分配 Worker 或 MCP 服务器，也不影响 `memory__recall`。ContextView 不会自动注入语料内容。详见[知识库指南](../knowledge-base.md)。

敏感路径和内容检查位于 `runtime/src/memory/sensitivity.ts`，由知识模块、个人记忆入库和执行器引用处理共用，因此任何路径上疑似凭据的内容都会在入库或发送给模型服务之前被拒绝。
