# 06 记忆底座：账本 / 条目 / 视图

> 目标：把 Nova 的持续理解收敛到**一套**底座上。来源（对话、授权目录、邮件、IM、可核验的执行器结果）
> 只产证据；证据只追加；理解以修订日志形式派生；表现层只读视图。可追溯不是一层，是每条理解都带的属性。
> 本卷定义 `evidence_record`、`entry_revision` 两个底座契约，03 卷的 `memory_entry` 与 02 卷的 proposal
> 都是它们之上的投影。

状态：待评审。对应里程碑"记忆底座"。本卷不改产品代码。

## 0. 为什么要这一卷

2026-09-12 对照 mem0、VoiceMem、OpenClaw、today.ai、mycontext 与同事的
"Human-centric × Work-centric" 架构图（对照记录见
2026-09-12 记忆参考项目对照记录（已不在仓库）），
得出三条结论：

1. 现有三套记忆（会话黑板、VoiceMem 个人记忆、历史工作区存储）各自为真，03 卷要求的
   逐条 ID / 版本 / origin / 纠正传播在任何一套里都不完整。再按参考项目各加一层只会更散。
2. 记忆层内部应按**数据变更方式**分阶段，而不是按参考项目或按"人 / 工作"分库。变更方式只有三种：
   只追加、受控修订、只读重算。
3. "有迹可循"是每条修订都必须带的 `evidence_refs`，不是独立的一层；把它单独立层会让两层互相持有指针，
   永远解不开。

## 1. 现有基础（2026-09-12 核实）

- `runtime/src/memory.ts`：会话内运行时黑板（`Memory` / `Channel`，按 handoff 通道编号的 `MemoryItem`），
  `docs/archs/02-memory.md` 的 L0。**不进本卷底座**；它是当前会话事实，不是持续理解。
- 已有 SQLite 存储模块：`models.ts` 已有 `EvidenceRefSchema`、`ObservationSchema`（只追加观测）、
  `LogicalWorkspace` / `WorkspaceInstance` / `RelationCard`（带 revision 的派生卡片）、`RecallPack`；
  `store.ts` + `store-worker.ts` 由 Worker 独占 SQLite；`projector.ts` 产出 不可变存储快照；
  `identity.ts` 做工作区别名归一（`candidate | confirmed | suppressed`，ASR 别名置信上限 0.25）；
  `sensitivity.ts` 有 `SensitivePathPolicy` 与字段级 `SensitiveContentPolicy`。这套已经是
  "账本 + 条目 + 视图"的雏形，对应 `docs/archs/02-memory.md` 的 L1–L4，本卷以它为底座的**第一个实现**。
- `runtime/src/memory/personal-memory.ts`：`PersonalMemoryResource` 端口（`recall` 必选，
  `remember` / `forget` / `responseAdaptation` 可选）；`factory.ts` 选择本地 VoiceMem sidecar 或
  `remote-personal-memory.ts`。命中没有稳定 `entry_id`、版本、origin；`forget` 按轮次；无 `list`。
- `runtime/src/context-view.ts`：唯一面向模型的同步有界投影。
- `runtime/src/realtime-assembly.ts` 的 `responseAdaptationFor()` 把 `<reply_preferences>` 同步注入；
  `runtime/src/tool-schema.ts` 的 `memory__recall` 工具带 `source: session | personal`。
  实时语音路径没有逐轮 prompt 组装，记忆只能经 host item 或工具结果进入模型。
- `runtime/src/suggestions.ts` + `runtime/src/floor.ts`：Suggestion Pool 与说话权仲裁，是本卷视图层的消费者。
- `runtime/src/knowledge/`：用户主动导入的资料库，独立 SQLite Worker，存分块与 embedding。
  `docs/archs/02-memory.md` 明确它不是 L0–L4 的一层；与本卷账本的关系见 §5.1。
- `docs/superpowers/specs/2026-09-05-native-ts-memory-design.md`：原生 TS 双脑（事实 + 情绪/风格）设计，
  未实现。本卷把它定位为 B 阶段 human-centric kind 的候选写入方，不改该文档。

## 2. 三个架构层与记忆层内部的三个阶段

```text
┌─ 表现层 ─────────────────────────────────────────────────────┐
│  回复风格 / memory__recall / proposal（02）/ 记忆页（03）       │
│  只读视图；唯一写回动作 = 用户纠正，且它作为证据回到 A           │
├─ 记忆层 ─────────────────────────────────────────────────────┤
│  C 视图（只读重算）  fold 当前态；四种投影；发布快照；降级用上一份 │
│  B 条目（受控修订）  entry_revision 只追加；merge 是唯一写入口     │
│  A 账本（只追加）    evidence_record 存原文；用户删除来源时物理删除     │
├─ 来源层 ─────────────────────────────────────────────────────┤
│  对话 / 授权目录 / 邮件 / IM（飞书）/ 可核验的执行器结果          │
│  连接器只做一件事：把变化写成 evidence_record                    │
└──────────────────────────────────────────────────────────────┘
```

A / B / C 是记忆层**内部的三个阶段**，不是三个部署单元：同一个 SQLite 文件里三族表，
一个 Worker 独占核心账本与修订；Knowledge 可沿用独立 Worker 维护可重建索引，原文仍以 A 为准。主线程与语音热路径只读发布快照（沿用 `docs/archs/02-memory.md` L1 / L3 的规则）。
数据只向上流；控制只有一条向下的路，就是用户纠正，而它也是先写进 A 再经 merge 进 B。

**2026-09-21 调整（见 [07 卷](07-memory-channels-and-interaction.md)）：** A 账本仍由 SQLite Worker 独占；B 修订与 C 投影的权威表示改为用户数据目录内 Git 仓库的 Markdown 文件（profile、五象限对象、entity、一页纸），SQLite 中的 `memory_revisions` 与向量表退为可重建索引。`merge` 签名、NOOP／add／update／tombstone 语义、纠正优先与乐观并发不变，只是输出从写行改为写一批文件加一次 commit。原文不进 Git，保留期与物理删除规则不受影响。

| 阶段 | 变更模型 | 写入者 | 读者 | 对应 archs/02 |
|---|---|---|---|---|
| A 账本 | 只追加；用户删除来源数据时物理删除该来源的行 | 连接器、对话轮次入账、执行器结果入账、用户纠正 | merge、重抽取、记忆页"查看依据" | L1 观测 |
| B 条目 | 只追加的修订日志；不原地改 | 仅 merge 纯函数 | fold | L2 卡片 + 乐观修订 |
| C 视图 | 只读重算；发布快照 | 无 | 表现层全部消费者 | L3 快照 + L4 投影 |

## 3. A 阶段契约：`evidence_record`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定；`entry_revision.evidence_refs` 的引用目标；沿用 `EvidenceRefSchema` 的形态 |
| `source_id` | string | 用户命名空间内的来源代次 ID；连接器归属沿用 04 卷；文件替换创建新代次，撤回旧代次依据；对话与任务保留原始关联 |
| `source_kind` | `conversation \| file \| mail \| calendar \| im \| task_result \| user_correction` | `user_correction` 是用户在记忆页的纠正 / 忘记动作本身 |
| `locator` | string | 能回到原处的定位：文件路径 + 修改时间、邮件消息 ID、IM 消息 ID、事件 `MemoryRef` |
| `cursor` | string \| null | 连接器同步游标，重放与恢复用 |
| `observed_at` / `recorded_at` | ISO 8601 | 依据发生时间 / 写入时间，分开 |
| `raw_text` | string \| null | **存原文**（2026-09-12 决定）。经字段级 `SensitiveContentPolicy` 处理；被整段屏蔽时为 null 并在 `sensitivity` 记录原因 |
| `extracted` | object | 入库时的结构化抽取（见 §7）：候选条目、实体、日期；是模型输出，**本身不是证据** |
| `hash` | string | 归一化内容哈希；03 卷"忘记后不再生成"的抑制标记以它为键 |
| `sensitivity` | `{policy_version, redactions[]}` | 应用了哪版策略、屏蔽了什么类型 |
| `consent` | `{provider_fingerprint}` 或缺省 | 该段原文的 embedding 外发许可；缺省不允许，离线迁移不新授予许可 |
| `retention_until` | ISO 8601 \| null | 原文保留期；到期后 `raw_text` 置 null，行保留 |
| `trust` | 沿用 `runtime/src/events.ts` 的 `trustSchema` | 外部内容一律低信任；`user_correction` 最高 |

规则：

- 来源内容只追加；同一来源同一 locator 的新版本是新行，`cursor` 与 `hash` 区分。异步抽取结果追加到独立 extraction 记录。只有保留期清正文与用户删除可以执行隐私维护更新。
- **断开连接停止读取与机器人、清除本地用户登录，但保留历史；只有删除来源数据才物理删除该 `source_id` 的全部行**。B 阶段指向它们的
  `evidence_refs` 变成悬空引用，条目在默认关闭的来源调试视图里显示"证据已删除"（§5），不消失也不伪装仍有依据。
- 保留期是连接器配置：IM 原文默认 30 天；M8-Mail 邮件从接收时间起 30 天，日历从事件结束起 30 天，不因重同步延长；本地目录与对话默认长期。
  到期只清 `raw_text`，`extracted`、`hash`、`locator` 保留，追溯降级为"能回到原处看"。
- 敏感策略落在字段级：`raw_text`、`extracted` 内每个字符串字段、`locator` 各自过策略，
  复用 `runtime/src/memory/sensitivity.ts` 的 `SensitiveContentPolicy`，不新写一套。
- 模型对自己行为的叙述不能成为 `evidence_record`（§8）。

## 4. B 阶段契约：`entry_revision`

| 字段 | 类型 | 说明 |
|---|---|---|
| `entry_id` | string | 条目稳定 ID，跨修订不变；03 卷 `memory_entry.id` |
| `revision` | number | 单调；03 卷 `memory_entry.version`；02 卷 `memory_refs` 用 `entry_id@revision` |
| `supersedes` | number \| null | 被本修订替代的上一修订；首条为 null |
| `op` | `add \| update \| tombstone` | 对应 mem0 的 ADD / UPDATE / DELETE；NOOP 不产生行 |
| `kind` | 见 §6 | |
| `origin` | `stated \| inferred` | 沿用 03 卷语义；`written_by = user_correction` 时必为 `stated` |
| `written_by` | `merge \| user_correction` | **同一种记录**，不分两张表；记忆页修订历史一套渲染 |
| `evidence_refs` | array of `evidence_record.id` | 至少 1 条；可悬空（§5） |
| `entity_refs` | array of `entry_id` | 指向 `kind = entity` 的条目，两视角共享实体的落点 |
| `content` | object | 按 kind 定形；用户可读一句话由 C 阶段投影生成 |
| `valid_until` | ISO 8601 \| null | 有时效的状态（"这周在赶演示"）；过期后不进投影，历史可查 |
| `recorded_at` | ISO 8601 | |

**merge 是唯一写入口**，签名固定为纯函数：

```text
merge(current: FoldedEntry | null, candidate: Candidate, policy) -> NOOP | add | update | tombstone
```

- `candidate` 来自入库抽取（§7）或用户纠正；带 `evidence_refs`、`origin`、`written_by`。
- 不变量（吸收自 mycontext，已在 历史存储规格 的 Design rules 中）：
  数据库为真；`written_by = user_correction` 优先于任何 `merge`，且后者不能覆盖前者，
  除非新的用户纠正；agent 自身输出不作候选；同一 `hash` 已被用户忘记（03 卷抑制标记）则 NOOP；
  来源撤回级联：其 `evidence_refs` 全部悬空的条目自动写一条 `tombstone`，`written_by = merge`，
  content 记录原因 `evidence_deleted`。
- NOOP 判据：候选与当前态内容等价（按 kind 的归一化比较）且 `origin` 不升级、`valid_until` 不延后。
- 乐观并发：`candidate.expected_revision` 与当前 fold 的 `revision` 不一致则拒绝，由调用方刷新重试。
  这就是 03 卷 `correct(entry_id, expected_version, …)` 的底层实现。
- **重抽取**：对账本一段范围重新跑 §7 的抽取并逐条 merge。只产生新修订，不改旧修订；
  旧修订的 `evidence_refs` 不变。用于换模型或修 bug 后回填。

## 5. C 阶段契约：视图

fold 规则：按 `entry_id` 取最大 `revision`；`op = tombstone` 则条目不在当前态；
`valid_until` 已过则不进任何模型投影，记忆页可在"已过期"筛选中看到。

| 投影 | 延迟档 | 输入 | 输出 | 现有落点 |
|---|---|---|---|---|
| 回复偏好 | 同步 | `kind = preference`，`origin = stated` 优先 | `<reply_preferences>` | `realtime-assembly.ts` |
| 按需回忆 | 请求时 | 查询 + 作用域 | 有界的条目与原文节选，见 §5.1 | `memory__recall` |
| proposal 候选 | tick | 02 卷快照所需的少量相关条目 + commitment 到期窗口 | 02 卷 §2.2 的"少量相关个人记忆" | 02 卷适配层 |
| 记忆页 | 列表 / 分页 | 全部 active 条目 | 03 卷 `memory_entry` | 03 卷 |

- 每次 fold 结果作为不可变快照发布；消费者只读最新快照，发布失败时继续用上一份并可见地标记降级
  （沿用 不可变存储快照 的做法）。
- **悬空 `evidence_refs`**：条目仍在当前态时，投影里该依据显示为"证据已删除（来源 X，时间 T）"，
  `locator` 不再展示；全部悬空的条目已由 §4 级联墓碑处理。
- 视图层不写任何东西。记忆页的纠正 / 忘记走 `client.command`，主机把它写成
  `source_kind = user_correction` 的 `evidence_record`，再经 merge。

### 5.1 统一回忆（含 RAG）

`memory__recall(query, scope)` 是 C 阶段统一入口。主机并行检索 B 当前态和 A 原文索引，模型不选择存储。`scope` 表示时间范围；当前 `recent` 仅查询近期 B 条目及其关联 A 原文，`any` 同时查独立文档索引，预检索和 tick 使用 `any`；显式 `source=session` 保留 L0 会话黑板回忆，兼容的 `source=personal` 也走统一回忆。

- 返回 `entries`（理解）与 `snippets`（原文节选）两层，总量与正文均有预算。条目携带 `entry_id@revision`、`origin=stated|inferred` 和 `evidence_refs`；推断不能冒充用户确认的事实。
- 节选携带 canonical `evidence_id`、`locator`、发生时间和 `trust=untrusted_external`。索引与条目命中同一依据时只返回一份节选，不以 locator 临时伪造账本 ID。
- 只读 `memory__evidence(evidence_id)` 下钻到 A 中有界原文段落，接替本路径的 `get_chunk`。读取时重新校验作用域、保留期、删除和抑制状态；已删除返回 gone，后端失败返回 unavailable，不混同空结果。
- 更正、遗忘和来源删除必须使旧修订与派生索引失效；返回前再次验证当前态。检索不触发抽取，不把外部内容变成指令或执行权限。
- 02 卷 tick 使用同一融合投影与同一引用格式；模型不另行选工具。会话黑板仍是独立 L0 运行时事实，不搬入底座。

`knowledge/` 复用现有分块、FTS 与 embedding，作为 A 的可重建索引。原文先入 A，再写索引；已有文档迁移到 A 后建立 canonical ID 映射，保留原库直到迁移验证通过。索引中的缓存正文不能成为另一份事实来源，读取须回到 A 校验。导入文档是一种来源及保留策略，不是第三套记忆。

embedding 外发仍须显式同意，并绑定授权范围与 provider。没有同意时保留本地词法检索；并库、迁移、已有向量或另一个来源的授权都不能自动授予外发许可。B 条目由多个原文派生时，所有有效依据均须允许该 provider 才可外发。

### 5.2 两级检索与语音管线

> 历史实现说明：以下预检索段落记录此前已验收的路径。2026-09-21 的新读取策略以 07 卷为准：文本默认目录＋按需工具（可显式开启文本预检索），实时语音默认 profile＋一页纸；`MEMORY_PRERECALL_ENABLED` 默认改为 `false`。

一级预检索仅用于 cascaded：每轮用户输入在 LLM 开口前读取 §5.1 的有界结果，最多 3 条并限制总上下文预算；低于相关性门槛、超时或失败不注入。以可替换、低信任的上下文拼入本轮 system，明确“可能相关，不确定时忽略”，不写入对话历史，不覆盖回复偏好。用户可设置 `MEMORY_PRERECALL_ENABLED=false` 关闭预检索，退回显式回忆。默认开启；桌面设置的“回答前查找相关记忆”也可关闭，保存并重启生效。

二级为模型按需调用 `memory__recall` / `memory__evidence`，接受一次工具往返。integrated 按 D2 保持纯语音低延迟模式，只使用二级，不向下一轮异步塞入本轮检索结果。

预检索可与 ASR 中间转写重叠，但缓存必须绑定会话、回合、查询内容和作用域；文本变化取消旧查询，定稿不匹配时重新查询或放弃，禁止沿用上一轮结果。相同的已校验结果可供 02 卷 tick 使用，交付前仍须检查修订与依据是否有效。

先测量 embedding、索引查询、上下文注入和完整回复延迟，再决定本地 embedding 或查询缓存。VoiceMem 上游的本地 E5 性能不能代表当前远端 embedding 管线；不把估算写成验收结果。现有 M7 已调用 Knowledge 建索引，新增工作是 A 归属与统一读取，不按旧描述重复接入。

## 6. kind 目录

| kind | 视角 | content 要点 | 来源 |
|---|---|---|---|
| `fact` / `preference` / `plan` / `concern` | Human-centric | 沿用 03 卷 §2.2 定义 | 对话为主；VoiceMem / 原生 TS 双脑作为写入方 |
| `commitment` | 两视角交界 | `direction: owed_by_me \| owed_to_me`、`due`（可空）、`counterparty` → `entity_refs`、`status: open \| done \| dropped` | 对话、IM、邮件；抽取规则 §7 |
| `entity` | 共享 | `entity_kind: person \| project \| workspace`、别名列表 | `identity.ts` 已做 workspace；person 归一待评审 |
| `topic` | Work-centric | 标签 + 出现范围 | 授权目录（today.ai 式关键词，证据指向文件） |
| 历史工作区存储 的 `LogicalWorkspace` / `WorkspaceInstance` / `RelationCard` | Work-centric | 保持现有 schema | 现有 projector 改为经 merge 写修订 |

Human-centric 与 Work-centric 是同一张修订表上的 kind，不是两个库。一条 `commitment` 的
`counterparty` 与一条"重要关系"的 `fact` 指向同一个 `entity` 条目，这是"两个视角关联同一份事实"的物理含义。

`commitment` 到 02 卷 suggestion kind 的映射：`owed_by_me` → `notify`；`owed_to_me` → `followup`。
`due` 是抽取出的截止时间，**不是**依据的发生时间；02 卷"记忆的发生时间不当作未来截止时间"仍然成立。

## 7. Discovery 拆成两半

| 半 | 何时 | 属于 | 输入 → 输出 |
|---|---|---|---|
| 发现即抽取 | 入库时，每条 `evidence_record` 写入后 | A → B 写路径 | 原文 → `extracted`（候选 `commitment` / `fact` / `entity` / 日期）→ 逐条 merge |
| 发现即筛选 | 02 卷的 `tick` 与来源变化机会 | C 视图 → 02 卷 | 当前态 + 时钟 + 近期交付 → 少量值得此刻提的条目，交给 Proactive |

- 抽取是有界的一次模型调用，输出经 zod 校验后才进 `extracted`；校验失败记录并跳过，不阻塞入账。
- 抽取结果全部是 `origin = inferred`，除非来源本身是用户在对话中的明确表达（`user_confirmed`，
  非 ASR 原始转写，沿用 历史存储规格 的 `user_transcript` vs `user_confirmed` 区分）。
- 筛选不调用工具、不新增条目，只是 02 卷 §2.2 快照的供给方；02 卷 Proactive 的职责不变。
- 同事架构图上的 "Discovery" 框只是后一半；前一半画进 Memory 框内（改图意见见对照记录）。

## 8. 执行器结果入账规则

右侧来源"任务与工具结果"只在**有可核验产物**时产生 `evidence_record`：文件被修改（路径 + 哈希）、
PR / commit 已创建（URL 或 SHA）、命令返回码与截断输出、`EXECUTOR_TASKS` 里主机确认的
`completed` 事实。`source_kind = task_result`，`locator` 指向产物。模型对"我做了什么"的叙述、
进度气泡文案、Proactive 的 reason 一律不入账。这是 mycontext "agent 输出不作证据"在 Nova 的落点。

## 9. 不做

- 不生成叙事式人物画像作为主体（D3 不变）。
- 不引入向量数据库或 mem0 作为依赖；mem0 的贡献只是 §4 的 merge 动作集合。2026-09-21 核实 mem0ai 3.2.0 OSS 的 `add()` 只做 ADD，不承担合并判定，不进写路径。
- 不在 06 卷底座之外新建记忆存储；VoiceMem 与 历史工作区存储 改为写入方，不再各自为真。
- 不让 renderer、模型或语音热路径直接读写底座 SQLite。
- 不另起 RAG 真相源或规格卷；复用现有知识索引，归入 §5.1。
- 不做精确到点的提醒（02 卷不变）；`commitment.due` 只供筛选，不承诺时效。

## 10. 待评审

| 项 | 选项 | 影响 |
|---|---|---|
| `knowledge/` 与 A（已定） | 原文归 A，资料库退为分块与检索索引 | 迁移保留原库并验证；继承 embedding 外发同意，默认不外发；见 §5.1 |
| VoiceMem 改造成 B 写入方的路径 | sidecar 输出候选由主机 merge / 原生 TS 双脑直接替代 sidecar | 前者保住现有后端；后者依赖 09-05 设计落地 |
| IM 与邮件原文默认保留期（已定） | IM 保持现有 30 天；邮件接收后 30 天；日历结束后 30 天 | 见 M8-Mail 设计 §7（本地文档）；原文到期与服务商删除区分 |
| person 实体归一 | 复用 `identity.ts` 的 candidate / confirmed / suppressed 机制 / 只按连接器给的稳定 ID，不做跨来源归一 | 前者能把飞书里的人和邮件里的人对上，误合并风险需 ASR 式置信上限 |
| 历史工作区存储 迁移时机 | 底座里程碑内一次迁 / 先并行写、后切换 | 前者干净，后者可分步验收 |
| B／C Markdown 迁移顺序（2026-09-21） | 先统一写入契约再迁 LifeService JSON 与修订表 / 先迁 LifeService 再迁修订表 | 前者双写窗口短但一次改动大；后者可分步验收但两套契约并存更久 |

## 11. 验收场景

编号续 02 / 03 / 04 卷，从 12 起。

- **12 纠正只出新修订**：用户纠正一条 `inferred` 条目；账本多一条 `user_correction` 记录，修订表多一条
  `written_by = user_correction`、`origin = stated` 的修订，fold 只返回它；依赖旧修订的 pending
  suggestion 撤回，`feed_item` 置 `invalidated`（与 03 卷场景 7 一致）。旧修订原样可查。
- **13 用户删除来源时物理删除**：删除一个 IM 来源的本地历史；该 `source_id` 的账本行物理消失；只依赖它的条目自动
  出现 `tombstone`；同时有对话依据的条目保留，默认关闭的来源调试视图显示"证据已删除"。
- **14 重抽取不改历史**：对同一段账本用新抽取器重跑；产生的新修订 `supersedes` 指向旧修订；
  旧修订与其 `evidence_refs` 不变；内容等价的候选为 NOOP，不产生行。
- **15 承诺从飞书消息抽出并被筛选**：fixture 里一条飞书消息"周五前把评审意见发我"；入库抽取出
  `commitment{owed_by_me, due=本周五, counterparty=发送者}`；周四的 `tick` 筛选把它交给 Proactive；
  用户在对话中说"已经发了"后，merge 写 `status: done` 修订，下次 tick 不再筛出。
- **16 有时效条目过期**：`valid_until` 已过的条目不出现在回复偏好、回忆、proposal 候选三种投影；
  记忆页"已过期"筛选可见，修订历史完整。
- **17 叙述不入账**：执行器报告"已修复测试"但没有产物；账本无新行。同一任务产生了 commit SHA 时，
  账本有一行 `task_result`，`locator` 是该 SHA。

- **20 一次回忆两类结果**：同一问题同时命中 B 条目与 A 文档段落；条目带修订与 stated/inferred，段落保持低信任，重复依据只返回一次；不用切换存储工具。
- **21 预取后删除**：部分转写已取回结果，用户删除来源或更正条目后才结束说话；正式注入前重验，旧段落/修订不进入模型；显式 evidence 读取返回 gone。
- **22 离线迁移不追加授权**：迁移已有知识分块和向量时不重新抓取文件、不调用 embedding；A 中未获得新的 provider 外发许可，索引不能复活已删除原文。
- **23 两级管线与开关**：cascaded 定稿只复用同回合、同查询的预取，最多 3 条；无关或超过等待预算不注入。关闭开关后仍能显式回忆；integrated 不执行预取。
- **24 目录摘要引用同一原文**：目录摘要的 B 条目引用 Knowledge 已写入的 canonical A ID；重复观察不新建副本，文件替换撤回旧来源代次与旧记忆，再写新代次。

## 2026-09-12 实施约定

Knowledge 作为 A 的派生索引，统一回忆属于 C 阶段。个人记忆和 历史工作区存储 共用现有 Worker/SQLite；旧 VoiceMem 数据只读迁入并保留原数据库。候选抽取复用现有模型 gateway，merge 是唯一修订入口。工作区旧表作为修订结果的物化视图保留。人按连接器稳定身份记录，不自动跨账号归一。

2026-09-21 设计调整：B／C 权威表示改为 Markdown + Git，A 留 SQLite；整理节奏为逐条入库加每日批量；详见 [07 卷](07-memory-channels-and-interaction.md)。尚未实施。

2026-09-20 实现补充：连接级 processing grant 是对象 grant 的上层效力门控；撤回同意在对象级传播中崩溃后，恢复同步也不能重新允许旧对象处理。同步状态、continuation 和删除代际恢复均复用来源存储。见本地验收记录。
