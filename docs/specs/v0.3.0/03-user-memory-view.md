# 03 用户视角记忆

> 目标：让用户看到 Nova 对自己形成了什么理解、依据是什么、什么时候形成的，并且能纠正和忘记。
> 纠正不是改 UI 文案：后续检索、未交付的 proposal 和 feed 事项都必须看到新状态。
> 本卷定义 `memory_entry` 契约。它是**投影**，不是新的存储层：目标底层是 [06 卷](06-memory-substrate.md)
> 的 `entry_revision` 修订日志（B 阶段）经 fold 得到的当前态（C 阶段）。`v0.3.0dev` 当前实现把稳定 ID / 版本 /
> 纠正 / 忘记放在现有 VoiceMem Worker 里，是通往 06 卷底座的过渡形态，接口语义一致。

状态：M6-A 已在 `v0.3.0dev` 实现；底座收敛见"记忆底座"里程碑。

## 1. 现有基础

- `runtime/src/memory/personal-memory.ts`：`PersonalMemoryResource` 端口，`recall` 必选，
  `remember` / `forget` / `responseAdaptation` 可选。写入以可信对话轮次为单位
  （`PersonalMemoryRememberTurn`），不接受外部资料冒充用户发言。**端口的现有能力不足以支撑本卷**：
  `forget(sourceId)` 按来源（轮次）粒度删除，不是按条目；`remember` 只保证轮次被接纳持久化，
  不保证派生条目立即完成纠正；`recall` 的命中没有逐条稳定 ID 与版本、没有 stated / inferred 标记，
  也没有列表接口。
- `runtime/src/memory/factory.ts`：按 `Settings` 选择远程或本地 VoiceMem 后端。
- `runtime/src/core/context-view.ts`：唯一面向模型的有界投影。
- 桌面 `clients/desktop/src/renderer/memory-board.mjs`：面向开发者的通道 / 诊断视图，
  没有用户视角、没有来源与 stated / inferred 区分。
- 知识库（`runtime/src/knowledge/`）保存源内容与分块；它是**资料库**，不是记忆。
- **没有用户画像层**，也没有任何"关于你"的生成摘要。

## 2. 本卷新增

### 2.1 `memory_entry` 是投影，能力由端口提供、最终由 06 卷底座统一提供

`memory_entry` 由主机从 personal-memory 端口读出并整理，面向用户展示。它不新增存储。
下列能力在 `v0.3.0dev` 已由扩展后的 VoiceMem Worker 提供；"记忆底座"里程碑落地后由 06 卷底座统一提供，
VoiceMem 与 历史工作区存储 改为底座的写入方（经 merge 写修订），不再各自实现这些接口：

| 新增能力（可选实现） | 契约 | 用途 |
|---|---|---|
| `list(scope, cursor)` | 返回条目集合，每条带稳定 `entry_id`、单调 `version`、`origin`、`source_refs`、`observed_at` | 记忆页列表；不能用 `recall("")` 代替 |
| `get(entry_id)` | 返回单条当前版本；不存在或已忘记返回明确状态 | 02 卷入池前与交付前的版本校验 |
| `correct(entry_id, expected_version, new_content, user_source)` | 乐观并发：版本不匹配拒绝；成功后原条目 `corrected`，新条目 `stated`，返回两者 ID 与版本 | 纠正 |
| `forgetEntry(entry_id, expected_version)` | 按条目忘记，并写入抑制标记 | 忘记（区别于现有按来源的 `forget(sourceId)`） |
| `capabilities()` | 声明上述哪些已实现 | UI 如实显示不支持的操作 |

底座尚未接入某个写入方（例如 VoiceMem 仍在迁移）时，来自该写入方的条目在能力声明中标为
只读，记忆页禁用相应按钮并解释原因，不能假装成功。02 卷的记忆版本校验依赖 `get`；后端不提供版本时，02 卷必须把 `memory_refs`
视为不可校验并拒绝依赖它的 proposal，而不是跳过校验。

`version` 即 06 卷的 `revision`。

### 2.2 契约对象：`memory_entry`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 底层稳定 `entry_id`，由 §2.1 的 `list` / `get` 提供 |
| `version` | number \| string \| null | 底层单调版本；proposal 的 `memory_refs` 用它做一致性校验；后端不提供时为 null 且条目标记"不可校验" |
| `content` | string ≤ 500 | 用户可读的一句理解 |
| `kind` | `fact \| preference \| plan \| concern \| commitment` | 事实 / 偏好 / 有日期或将来时的安排 / 进行中的关注点 / 承诺（我欠别人或别人欠我，06 卷 §6） |
| `origin` | `stated \| inferred` | 用户明确表达 vs Nova 推断。只有 `stated` 可作为偏好覆盖等高信任用途 |
| `source_refs` | array of `{type: conversation \| file \| mail \| calendar \| task, ref, observed_at}` | 至少 1 条；`inferred` 条目必须能展开看到推断依据 |
| `observed_at` | ISO 8601 | 依据发生的时间，不是写入时间 |
| `valid_until` | ISO 8601 \| null | 有时效的状态；过期后不进模型投影，记忆页"已过期"筛选可见 |
| `entity_refs` | array of entry id | 指向 `kind = entity` 的条目（人 / 项目），human-centric 与 work-centric 共享 |
| `recorded_at` | ISO 8601 | 写入时间 |
| `topic` | string | 用户可理解的主题，用于分组（工作 / 生活 / 项目名等），由主机归类 |
| `status` | `active \| corrected \| forgotten` | 见 §2.3 |
| `corrected_to` | string \| null | `corrected` 时的新内容 |
| `confidence_note` | string \| null | 覆盖范围或不确定性说明，例如"仅来自目录名" |

接口内容，不是已发布 wire schema；落地时以 zod schema 与 fixtures 钉住。

### 2.3 纠正与忘记

| 操作 | 底层动作 | 传播 |
|---|---|---|
| 纠正 | 调用 `correct(entry_id, expected_version, …)`；底座形态下写一条 `source_kind = user_correction` 的证据，再经 merge 写一条 `written_by = user_correction`、`origin = stated` 的修订；原修订被 supersede 且可查 | 依赖原条目的 pending suggestion 撤回；相关 `feed_item` 置 `invalidated`；后续 recall 只返回新条目 |
| 忘记 | 调用 `forgetEntry(entry_id, expected_version)`；条目 `status: forgotten`，内容不再展示 | 同上；此外记录一条**抑制标记**（hash 依据），来源下次同步产生相同推断时不重新生成 |
| 忘记整个来源 | 现有 `forget(sourceId)`；该来源派生的全部条目 `forgotten` | 走 04 卷"删除来源数据"路径 |
| 查看来源 | 只读 | 无 |

- 纠正的新内容是 `stated`，即使原条目是 `inferred`。
- 忘记只影响记忆，不删除资料库里的源内容；用户若要删除源，走 04 卷的"删除来源数据"。
- 有其他独立依据的记忆，在其一个来源被删除时保留有效部分，不整条删除；`source_refs` 减少并记录。
- 纠正和忘记是 trusted_user 动作，通过既有 `client.command` 承载，带 request_id 与去重回执。
- 纠正与忘记都是**读后写**：UI 提交时带当前 `version`，版本不匹配则拒绝并刷新条目，不静默覆盖。

### 2.4 摘要优先的记忆概览（2026-09-11 用户确认）

记忆页默认先展示摘要总览卡与可点击的关键词，再按现有类别汇总。原始条目、来源与纠正/忘记操作放在可展开详情内。规则：

- 必须以覆盖声明开头或结尾，格式含**依据条数**与**来源范围**，例如
  "基于 37 条记忆，来源仅有对话与你授权的 2 个目录"。
- 只能引用 `active` 条目；每个论断可点击定位到条目。
- 资料不足时如实写"目前了解有限"；不得从目录名、文件名直接推断身份、职业或关系。
- 概览是派生视图，纠正条目后重新生成；概览本身不可被纠正。

### 2.5 与开发者视图的关系

现有 memory-board 保留为诊断视图，放在设置或开发者面板；记忆页是新的用户视图。
两者读同一底层，但记忆页只显示 `memory_entry` 投影，不显示通道、原始事件和图结构。

## 3. 不做

- 不生成缺少依据的叙事式"人物画像"；摘要只汇总当前有来源的有效记忆。
- 不在 06 卷底座之外新建记忆存储。
- 不让 renderer 直接访问 VoiceMem 或 SQLite。
- 不把知识库分块当作记忆展示。

## 4. 待评审

| 项 | 选项 | 影响 |
|---|---|---|
| 概览默认开关 | 已定：默认开 | 摘要卡与关键词优先，原始条目展开查看 |
| `topic` 归类方式 | 主机规则 / 模型归类后主机校验 | 模型归类更自然但需要校验与缓存 |
| 后端不支持 `forgetEntry` / `list` 时的 UI | 隐藏 / 显示但禁用并解释 | 建议后者，如实告知 |
| VoiceMem 迁为底座写入方的路径 | sidecar 输出候选由主机 merge / 原生 TS 双脑直接替代 | 见 06 卷 §10；未迁完前其条目在记忆页只读 |

## 5. 验收场景

- **7 记忆变化**：用户在记忆页纠正一条 `inferred` 条目。随后 recall 只返回新 `stated` 条目；
  一条依赖原条目的 pending suggestion 被撤回，其 `feed_item` 变为 `invalidated`。
- **忘记后不再生成**：用户忘记一条来自目录名的推断；下次同一目录同步时，相同推断不再出现在记忆页。
- **来源部分删除**：一条记忆有对话与文件两个依据；删除文件来源后条目保留，`source_refs` 只剩对话。
- **概览诚实**：仅 3 条记忆时，概览明确写出条数与来源，且不出现身份、职业断言。
- **后端能力**：接入不实现 `forgetEntry` 或 `list` 的后端时，对应按钮或列表禁用并显示原因；不出现"已忘记"的假成功。
- **并发纠正**：两个客户端同时纠正同一条目，后到者因版本不匹配被拒绝并看到新内容。
