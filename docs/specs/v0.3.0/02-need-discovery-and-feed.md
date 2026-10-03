# 02 需求发现与动态页

> 轨道 A。目标：让 Nova 在有依据时主动提出建议或问题，没有依据时保持沉默；建议在首页"动态"
> 以事项形式呈现，用户可以处理、稍后、忽略；同一事项在依据变化时更新或撤回。本卷延续
> [PASK](https://github.com/xzf-thu/Pask) 讨论的最小方案：**扩展现有 Proactive，复用现有 Suggestion
> Pool**，不引入独立需求模型或第二个对话 Agent。

命名：原 Surrogate 角色现称 Proactive；`surrogate.watch` 槽位、`origin: 'surrogate'`、`SURROGATE_SYSTEM` 等序列化标识和提示词常量保留历史拼写。

状态：待评审。本卷只定边界与验收；对应里程碑 M5-A、M6-B。

## 规划补充：从开口判断到需求发现

v0.2 的 Surrogate（现称 Proactive）从候选建议中选择“什么值得说、何时说”；v0.3 增加“是否存在值得关心的需求”。
两者仍在既有边界内协作：个人记忆（VoiceMem）提供用户侧的持续依据，主机提供当前项目与任务
上下文，当前对话与获准来源补充新事实。先用有界 ContextView；信息不足时走主机
拥有的有界记忆查询，Proactive 自身不调用工具，也不另建无限循环的研究 Agent。

[Pask 官方说明](https://github.com/xzf-thu/Pask) 将 DD-MM-PAS 分为需求检测、记忆建模与主动执行；
其 IntentFlow 描述了沉默、立即响应、先查记忆三类决策（核对日期：2026-09-10）。
Nova 借鉴这一职责拆分，不在本版引入训练模型，也不宣称复现 Pask 效果；下面的 proposal、
Suggestion Pool、Host 与 Floor 是 Nova 的具体设计。

验收需要同时包含：用户主动询问时依据记忆回答；未显式交办时发现一个有根据的需求；
没有活动任务时适度关心；依据不足时沉默；用户纠正/忘记后旧建议失效。建议可直接呈现为
关心或可选下一步，不能自动启动 coding/GUI；执行必须继承用户已有明确授权或先请求确认。
例如用户曾明确表示今天有演示准备，Nova 可在适当时机询问是否需要检查材料；不得仅凭
目录名推断其职业、情绪或健康状态，也不得替用户直接修改/发送材料。

## 1. 现有基础

- `runtime/src/core/suggestions.ts`：`SuggestionPool`。每条 suggestion 有 `origin`
  （`fast_brain | surrogate | executor`）、`kind`（`question | notify | followup`）、`content`、
  `evidence_refs`、`condition_key`、`delivery_policy`（`once | while_condition_true`）、
  `cooldown_until`、`expires_at`、`status`（`pending | fired | withdrawn | expired`）。
- Proactive 输出契约（`runtime/src/core/ports.ts`、`runtime/src/model/proactivity.ts`）：
  `{speak, suggestion_id, progress_class, reason}`。主机只接受本次提供给它的 suggestion ID。
- `runtime/src/model/prompting.ts` 的 `SURROGATE_SYSTEM`：Proactive 不生成给用户听的话、不调用工具，
  只决定此刻是否值得开口、选桌上哪一条。coding progress 有专门的分类路径（`progress_class`）。
- `runtime/src/realtime/floor.ts`：说话权仲裁 allow / preempt / defer，优先级 user 100、guard 90、
  active executors 50、ambient observation 40。
- `runtime/src/core/context-view.ts`：同步编译当前上下文；不宜直接塞入异步远程检索。
- 触发方式：**仅**执行器的 progress / observation / handoff 事件。runtime 有黑板维护、超时等内部
  定时器（`runtime/src/core/clock.ts` 等），但**没有用于需求发现的低频检查**，也没有提醒子系统。

## 2. 本卷新增

### 2.1 触发：三类判断机会

| 机会 | 触发条件 | 说明 |
|---|---|---|
| 上下文变化 | 现有路径：执行器事件进入 ContextView | 保持原语义；coding progress 的分类路径不混入 proposal 生成 |
| 来源变化 | 04 卷的来源记录（06 卷 `evidence_record`）产生新增、删除，或入库抽取写入了新修订 | 04 卷落地前该机会不存在，不用占位。**入库时的抽取（发现即抽取）不属于本卷**，见 06 卷 §7；本卷的“发现”只指从当前态里筛选此刻值得提的 |
| 低频检查 | 主机按配置间隔发出一个 `tick` 事件（默认间隔待评审，见 §5） | 只代表"获得一次判断机会"，不代表用户空闲、不代表必须开口 |

`tick` 进入事件记录（`EVENT_KINDS` 新增一种，命名待落地时定），携带本地日期、星期、时区，
便于解释与重放。没有正在运行任务时 `tick` 同样触发，这是"无任务主动关心"的唯一入口。

### 2.2 输入：有界快照

每次判断为 Proactive 准备一个**快照**，包含：

- 当前 ContextView（现有）；
- 少量相关个人记忆：通过 06 卷 §5.1 统一回忆在适配层**异步**取回 B 当前条目与 A 原文节选，形成有界列表，
  每条带 03 卷定义的稳定 `entry_id` 与 `version`（即 06 卷 `revision`；后端不提供版本时标记为不可校验）；
  `kind = commitment` 的条目按 `due` 与 `direction` 优先进入快照；
- 近期实际交付记录：最近 N 条已展示 / 已通知 / 已语音交付的事项摘要（N 待评审，建议 ≤ 8），
  防止重复提议；
- 时钟：本地日期、星期、时区。

快照携带 `user_scope`（用户与作用域）和实际使用的记忆版本集合。ContextView 保持同步编译；
异步检索在适配层完成后再组装快照，不改 `context-view.ts` 的同步契约。
统一结果保留 `entries` 与低信任 `snippets` 两层，依据使用 A 的 canonical `evidence_id` 与 locator；会话 MemoryRef 仍独立。tick 不抽取、不让模型选择资料库。proposal 只能引用本次快照中的依据和修订，准入与交付前重新校验，失效则撤回。

### 2.3 输出：追加可空 proposal

保留 `speak / suggestion_id / progress_class / reason` 原契约与原语义，追加一个可空字段：

```text
proposal (nullable):
  kind:          notify | question
  summary:       建议或问题的一句话内容（给用户看，≤ 200 字符）
  why_now:       为什么此刻相关（≤ 200 字符）
  evidence_refs: 当前快照中的运行时依据（事件 MemoryRef 或来源记录 ID），可为空数组
  memory_refs:   使用的个人记忆 {entry_id, version}，可为空数组；等价写法 entry_id@revision
```

`evidence_refs` 与 `memory_refs` **至少一类非空**。无任务场景下可能只有个人记忆，此时
`evidence_refs` 为空是合法的；两类依据分别校验（§2.4），保留运行时引用与个人记忆条目 ID 的区别，
不把记忆 ID 塞进 `evidence_refs`。

规则：

- 一次判断只能做一件事：沉默、选择已有 suggestion、或提出新 proposal。`suggestion_id` 与
  `proposal` 同时非空视为无效输出，主机丢弃并记录。
- `speak` 只对"选择已有 suggestion"路径生效，保持兼容。**新 proposal 不因 `speak=true` 而立即朗读**；
  它先入池，再由 §2.5 的呈现策略决定。
- 两类依据都为空、`evidence_refs` 引用快照外的 ID、`memory_refs` 的版本与快照不一致、`summary` 为空，
  都视为无效。
- coding progress 走原 `progress_class` 路径，本卷不改其语义，也不让 proposal 混入该路径。

这是接口内容，不是已发布 wire schema。落地时以 zod schema 与 `tests/fixtures/` 下的 golden 向量钉住，
且 `SURROGATE_SYSTEM` 的增量文案在 Node 适配器测试里断言（沿用现有做法）。

### 2.4 主机准入：校验、去重、入池

主机在入池前和交付前各做一次校验：

1. **来源与作用域**：proposal 的 `user_scope` 必须与当前会话一致。
2. **记忆版本**：通过 03 卷的 `get(entry_id)` 校验。任一条目已忘记、已纠正（版本不一致）则整条
   proposal 拒绝或重新评估；后端不提供版本时视为不可校验并拒绝，不静默沿用旧结论。
3. **运行时依据有效性**：`evidence_refs` 指向的事件仍在黑板或来源记录仍存在；来源已删除则拒绝。
   `memory_refs` 非空而 `evidence_refs` 为空时，只做第 2 项校验。
4. **事项键与去重**：主机（不是模型）为 proposal 计算稳定的 `subject_key`：优先取依据中的
   稳定实体标识（任务 `work_id`、日历事件 ID、邮件线程 ID、记忆 `entry_id`），没有稳定实体时才
   回退到 `hash(sorted(evidence_refs))`。去重键 `dedupe_key = hash(user_scope, kind, subject_key, local_date)`。
   校验对象是**持久化的交付与忽略台账**，不只是池内 pending / fired：同键在同一本地日期内已入池、
   已展示、已通知、已朗读或已被用户忽略，则本次不入池，记录为 `suppressed_duplicate`。台账持久化，
   程序重启后重放同样事件结果相同。新增一条无关事件不能让同一事项绕过去重；不宣称语义去重。
5. **分配**：主机分配 suggestion ID、`expires_at`（默认有效期待评审，建议 24 小时）、优先级
   （沿用 Floor 的 ambient observation 档，即 40；不允许模型指定）、`cooldown_until`。
6. **入池**：以 `origin: 'surrogate'`、`kind` 同 proposal.kind、`content: {summary, why_now}`、
   `evidence_refs` 写入 `SuggestionPool`。依据为 `commitment` 条目时，主机按其 `direction` 校正 kind：
   `owed_by_me` → `notify`，`owed_to_me` → `followup`；模型给出的 kind 与之不符则以主机为准并记录。

模型不能扩大权限、不能提高打扰等级、不能指定交付方式。

### 2.5 呈现：四类交付分别记账

每条入池的 suggestion 生成或更新一条 `feed_item`（§3）。交付分四类，各自独立记录，任何一类
成功都不推断另一类：

| 交付 | 触发条件 | 记录字段 |
|---|---|---|
| 首页展示 | `feed_item` 进入用户可见列表 | `presented_at`；**不等于用户已读** |
| 通知 | 主窗口收起且事项优先级达到通知阈值（阈值待评审） | `notified_at`、通知渠道 |
| 语音 | Floor 允许且用户未静音且当前 suggestion 被 Proactive 后续选中 | `spoken_at`；沿用现有 `fired` 路径 |
| IM | 用户开启了 04 卷 §2.5 的 bot 推送且事项优先级达到通知阈值 | `im_sent_at`、渠道标识；bot 发送成功不等于用户已读 |

"入池""选择""实际交付"是三个状态，不合并。语音交付失败（被 preempt、静音、连接断开）不能记为成功。

### 2.6 撤回与更新

三种转换分开处理，不合并：

| 触发 | suggestion | `feed_item.lifecycle` | `feed_item.user_state` |
|---|---|---|---|
| 来源更新使依据失效（会议取消、线程已回复）；记忆被纠正或忘记且 proposal 依赖它 | `withdrawn` | `invalidated` | 不变 |
| 关联任务已解决，或用户已在对话中处理 | `withdrawn` | `resolved` | 不变 |
| 用户在 feed 上忽略 | `withdrawn`（撤回提示，写入忽略台账） | **不变**，保持 `active` | `dismissed` |

忽略只代表用户不想看，不证明事情已解决或依据失效；事项以 `dismissed` 状态保留，
可在"已忽略"筛选中找回，并参与 §2.4 去重。同一事项得到新结果时**更新同一条** `feed_item`，不新建。

## 3. 契约对象：`feed_item`

主机拥有；由 Suggestion Pool 的准入结果生成和更新；UI 只渲染并回传用户动作。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 主机分配，稳定 |
| `kind` | `notify \| question \| task_result \| schedule \| change` | 前两者来自 proposal；后三者来自任务完成、日历安排、来源变化（后两者依赖 04 卷） |
| `title` | string ≤ 120 | 发生了什么 |
| `why_now` | string ≤ 200 | 为何此刻相关 |
| `evidence_refs` | array | 依据引用；UI 可展开查看 |
| `source` | `{type: conversation \| task \| memory \| file \| mail \| calendar \| im, ref}` | 信息来源 |
| `suggestion_id` | string \| null | 关联的 suggestion |
| `task_ref` | `{work_id}` \| null | 关联任务；任务详情以 `EXECUTOR_TASKS` 为准 |
| `subject_key` | string | 主机计算的稳定事项键（§2.4） |
| `memory_refs` | array of `{entry_id, version}` | 使用的记忆 |
| `priority` | number | 主机分配 |
| `created_at` / `updated_at` | ISO 8601 | |
| `expires_at` | ISO 8601 \| null | |
| `user_state` | `new \| seen \| snoozed \| dismissed` | 用户动作；`snoozed` 带 `snooze_until` |
| `lifecycle` | `active \| resolved \| invalidated` | 主机维护 |
| `delivery` | `{presented_at, notified_at, spoken_at, im_sent_at}` 各可空 | §2.5 四类记账 |

用户可执行的动作：`open`（进入对话或任务）、`act`（开始处理，走既有 `dispatch` 授权路径，
**不绕过**）、`snooze`、`dismiss`、`expand_evidence`。忽略反馈用于减少同类重复呈现（计入去重记账，
不训练模型）。

空状态展示真实的"暂无新发现"和可选入口，不编造内容填满页面。`feed_item` 需要持久化；
Suggestion Pool 只负责候选与交付调度，不当首页数据库。

## 4. 不做

- 不训练或引入独立需求检测模型；不做习惯预测。
- 不做精确到点的提醒。明确提醒需要另立可靠的提醒任务；本卷的机会性发现不承诺时效。
- 记忆的发生时间不当作未来截止时间。
- 不做语义去重、不承诺 exactly-once。
- 不改 coding progress 的分类与 offered-suggestion 校验。
- 提问或建议不授权后台执行；用户点"处理"仍走既有授权路径。

## 5. 待评审

| 项 | 选项 | 影响 |
|---|---|---|
| 低频检查默认间隔 | 15 分钟 / 30 分钟 / 60 分钟 | 越短越及时但模型调用越多；建议 30 分钟且用户可调、可关 |
| 通知阈值 | 仅 `question` 通知 / 全部 `notify` 也通知 / 用户配置 | 影响打扰感 |
| proposal 默认有效期 | 12 小时 / 24 小时 / 到当日结束 | 影响 feed 陈旧度 |
| 近期交付记录条数 N | 4 / 8 / 16 | 影响快照体积与去重效果 |
| 首页最终名称 | "动态" / 其他 | 只影响 UI 文案，不影响契约 |

## 6. 验收场景

编号沿用讨论稿 §9。

- **4 任务内发现**：用户明确提过演示目标，当前任务出现关键失败。Proactive 提出 `question` proposal，
  `evidence_refs` 同时包含用户陈述事件与失败事件；入池后 feed 出现一条事项，可追溯两类依据。
- **5 无任务发现**：没有运行中的任务；低频 `tick` 到来，快照中有一条带明确日期的近期记忆，
  Proactive 提出一次相关提问。相同条件但记忆缺少日期或过于陈旧时，输出沉默。两种情形都在固定案例集中。
- **6 不重复打扰**：同一事项在同一本地日期内第二次到达，主机记 `suppressed_duplicate`，不入池；
  用户忽略后同一事项再次到达同样被抑制；追加一条无关事件不改变结果；程序重启后重放同样事件，
  结果相同。语音交付被 preempt 时 `spoken_at` 保持空，事项仍在 feed。
- **仅记忆依据**：无运行任务、`evidence_refs` 为空、`memory_refs` 一条有效，proposal 通过校验入池；
  同样输入但该条目已忘记，拒绝。
- **忽略不等于解决**：用户忽略一条事项后，`lifecycle` 仍为 `active`，"已忽略"筛选可见；
  随后依据失效时才变为 `invalidated`。
- **7 记忆变化**：proposal 生成期间用户纠正了它依赖的记忆。入池前校验版本不一致，拒绝；
  若已入池，交付前校验拒绝并撤回 feed_item。
- **固定案例集**：至少 10 条"应提出建议"、10 条"应保持沉默"，每次改动跑全集，记录命中与遗漏。
  只追求建议数量不算通过。

### 补充评测记录

在既有正/负案例集上记录建议准确率与遗漏、无依据推断、每小时打扰次数、重复交付、
检索/决策延迟、用户纠正后的失效传播；比较关闭需求发现的 v0.2 基线与 v0.3 proposal。
另测无活动任务、用户忙碌/静默、过时记忆、冲突记忆及重启后的场景。
未经授权的执行必须为零；其余发布阈值在基线测量后、验收前固定，不以建议数量增加代替效果。

## 2026-09-12 修订：准备、简报与会话交付

所有主动内容集中进入固定「主动提醒」会话，不插入其他主题的对话。仅该会话自身占用实时语音、客户端在前台、未静音且 Floor 允许时可以播报；其他会话正在语音时静默到达。消息呈现、未读、通知与实际播报分别记账。

先准备再提醒：只允许读取已授权资料、检索、生成摘要和提纲。准备模型没有执行工具；材料保持低信任，发布及点击时复验来源与记忆修订。准备本身不授权发送消息、修改文件或启动 coding。具体行动按钮在用户点击后开启专题对话，外部执行仍走原审批机制。

每日前瞻和回顾分别默认关闭，不改变用户原有 discovery 设置。开启时默认工作日 08:30 前瞻、18:30 回顾，22:00–08:00 免打扰；全部使用设置时区。简报按本地日期、类型、时区去重，事项另行去重。当前实现只考虑当天两小时内的时刻，不补发旧队列；夏令时不存在的时刻跳过、重复时刻只发一次。准备前持久化占用键，因此进程崩溃或准备失败不会在同一日重复准备；不承诺失败自动补发。

验收包括跨重启去重、撤回失效材料、重复点击幂等、静音期间不播报、后台会话不抢焦点、菜单栏未读和并发已读确认。真实飞书投递与回调必须另行验收，不能用页面预览或模拟状态替代。
