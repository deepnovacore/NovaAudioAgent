# 8.07 手稿沉淀：Proactive × Realtime × Executor 架构笔记

> **状态**：2026-08-07 两页手写脑暴的转写与 repo 对照。非 canonical 架构，不占 R 编号；
> 不改动任何已定稿设计与评测契约。关键读法已于 2026-08-08 与用户逐条确认；
> 个别残留字迹以 ⍰ 标注，见 §7。
>
> **语言例外**：应用户要求正文中文；仓库其余文档维持英文规范不变。代码名与引文保持原文。
>
> **原件**：[`idea1-0807.jpg`](../../assets/ideas/v3/idea1-0807.jpg)（第 1 页）、
> [`idea2-0807.jpg`](../../assets/ideas/v3/idea2-0807.jpg)（第 2 页）。
>
> **输入（事实底座）**：术语与不变量以 [`glossary.md`](../glossary.md) 为准；
> 端口契约见 [`v3/04-ports.md`](v3/04-ports.md)；R111–R120 见
> [`v3/07-decision-record.md`](v3/07-decision-record.md)；TML 与 JoyAI 的 related-work 出处见
> [`03-related-work-survey.md`](../research/gptlive-eval/03-related-work-survey.md)。
> 文中仅以文件名提及的内部草案（`memory-realtime-bridge.md`、多执行器 roadmap、
> `pr-against-qwen-audio.md` 等）未随仓库公开。

每节先给**转写**（忠于原稿），再给 **repo 对照**，事实（已实现/已定稿）与设想（手稿提议）分开写。

## 1. 语音模型路线两档

**转写：**

- **伪全双工（Turn-Based）**：Qwen-Omni / Qwen-Audio / 级联管线
- **真全双工（utter）**：GPT-Live、Seed Realtime / MiniCPM-o (4.5)

白话：「伪全双工」指模型本质仍是一问一答的 turn 制，双工体验（随时插话、主动开口）靠工程手段在外面搭出来；「真全双工」指模型在 utterance 粒度上原生收发音频、可以自己决定何时开口。两档不是优劣，是模型能力与工程责任的重新划界。

**repo 对照（事实）：**

- 主线已集成 `qwen-audio-3.0-realtime-plus`；`qwen3.5-omni-flash-realtime` 比较过（内部 `realtime-probe` 系列）——都落在「伪全双工」档。
- GPT-Live（OpenAI Realtime）是研究基线：`gptlive-eval`、`gpt-live-continuous-voice`（内部研究记录）。
- MiniCPM-o 目前仅在内部视觉模态讨论稿出现两行（写作 MiniCPMO），Seed Realtime 在 repo 中无出处——两者都是**新候选**，未实测。

**设想：** 真全双工档的选型待实测，见 §7 开口 3。

## 2. 两级 Proactive（本手稿的核心分类法）

**转写＋用户确认的权威解释：** Proactive 有两级，粒度不同、场景不同、实现路线不同。

1. **turn-level**（粒度粗、偏指令向）。场景：语音委派下游执行器干活、定时提醒＋监控。实现两路：
   - **function call 型**：如 GPT-Live + codex、qwen-audio-agent 的做法；
   - **原生 tag 型**：如 JoyAI 模型直出 `<delegate>`。

   两路殊途同归的难题：**handoff 的处理 ＋ 事件循环归属**（执行器结果怎么回注、跑在同一事件循环还是独立循环）。
2. **utter-level**（粒度细、关注实时对话中的及时打断，由此突出「活人感」体验）。也有两路：
   - **audio 侧**：GPT-Live / TML 直接建模全双工模型；
   - **video 侧**：JoyAI 做了类似「画面定时器」的效果——画面持续 streaming 输入，模型按帧决定要不要开口。

**repo 对照：**

- （事实）turn-level 的 function-call 路线就是现行 Delegate/Handoff 机制：模型出 `DelegateRequest`，运行时 `bind_delegate` 补全，执行器以 Handoff（outcome/trust/content/refs 四字段）回注（[`glossary.md`](../glossary.md)、[`v3/05-executors.md`](v3/05-executors.md)）。
- （事实）原生 tag 路线的**单选枚举形态** `<response>/<silent>/<delegate>` 已被 [`v3/04-ports.md`](v3/04-ports.md)「Why Not a Single Three-Tag Enum」否掉——否的是「三选一」这个表达形式（无法同时 delegate＋回答），不是「模型原生表达行为」这个思路本身；FastBrain 的两轴输出正是它的替代品。
- （事实）事件循环归属在 repo 已有答案：单事件循环＋三个 single-flight 槽（[`v3/01-spine.md`](v3/01-spine.md)）。手稿此处是在盘点设计空间，不是翻案。
- （设想）utter-level 是 roadmap H 阶段（gpt-live M2）要面对的地盘；「video 侧画面定时器」在 repo 尚无对应物，最近的亲戚是 Stage 4 watch executor 的持续观察形态。

## 3. Proactive 实现方式三档

**转写：**

| 档位 | 手稿原文 | 含义 |
|---|---|---|
| 大原生 | TML（打断点：传在 Handoff Event ⍰） | 端到端建模，主动性长在模型里 |
| 半原生 | 模型直出 silence/response | JoyAI 形态：每次输入模型自己选说不说 |
| 工程/Agent | Surrogate/Policy →（Handoff/Suggestion 判断是否主动说）| 主动性由外部代理人＋策略裁决 |

手稿把第三档标为 **Ours v1**。

**repo 对照（事实）：** Ours v1 已经在跑，就是三件套：Suggestion pool（建议池，executor 结果先落池）＋ Surrogate（独立裁决「没人叫我时该不该说」，只选池子条目、从不生成词句）＋ Floor（说话权仲裁，allow/preempt/defer）。TML ＝ Thinking Machines Lab，作为「两循环交互形态」的 related-work 先例收录在 [`03-related-work-survey.md`](../research/gptlive-eval/03-related-work-survey.md)。

**设想（手稿的路线判断）：** 工程档起步，原生档是终局方向——与 §7 开口 1（FastBrain/Surrogate 职责合并）同一根轴。

## 4. 使唤「脑（语音入口 Agent）之外的存在」

**转写：** 让语音入口之外的执行器干活，机制＝ Delegate 入队列 ＋ Handoff 注入；跑在同一事件循环（使用侧）还是独立事件循环 ⍰。难点两个：

- **语境上下文**（3⍰ 语境上下文，ContextView）——给模型看哪份上下文；
- **Speaking Rights（说话权）**——何时说话。

**repo 对照（事实）：** 这两个难点在 v3 各有一册：ContextView 是模型唯一可读层、七字段纯函数编译（[`v3/03-context-view.md`](v3/03-context-view.md)）；说话权即 Floor（`prompting.py` 的提示词里就写「说话权状态」），仲裁结果 allow/preempt/defer（[`v3/01-spine.md`](v3/01-spine.md)）。手稿在此与现行架构完全同构，属确认而非提案。

## 5. 对比 qwen-audio-agent 的发力点

**转写：** 手稿列了四个发力点（承接内部 `pr-against-qwen-audio.md` 的对比姿态）：

| 手稿条目 | repo 现状 | 状态 |
|---|---|---|
| Codex/AppServer → 原生 Steering（工程） | M1 已落地：`codex_live.py` 的 `turn/steer(expectedTurnId)`，app-server 会话级预热（R94、R102） | **事实，已完成** |
| Memory × Channels（**控制面**，即当前 repo 的 control plane） | 内部 `memory-realtime-bridge.md` 的开口；`memory-candidates.md` 候选 5，四透镜全亮 | 提案中 |
| Multiple Executors（多执行器） | 当前分支工作：R111–R112 钉了基数解禁条件，Stage 4–6 在内部 roadmap 推进 | **进行中** |
| Proactive Policy（信息价值过滤） | 非既有定名；现行机制是 Suggestion pool ＋ Surrogate，手稿指其演进方向——按「信息价值」过滤哪些执行结果值得主动开口 | 设想 |

## 6. 什么执行器有 demo 价值

**转写：**

| 执行器形态 | 手稿判断 | repo 对照 |
|---|---|---|
| 长程任务、有中间结果（Codex Live） | ✓ | `codex_live.py` 已落地，中间产物可逐段回注 |
| 自闭环（Spawn → 视觉监控 → 反馈 ⍰） | ✓ | 对应 Stage 4 watch executor ＋ camera demo（内部 spec） |
| 轻量操作（HA，Home Assistant） | ✗ 无 Demo 意义 | 与 PR demo 差异化原则一致：开关灯这类操作无法与普通智能家居拉开差距 |
| 简单 MCP（信息查询 ⍰） | ？ | 未决，见 §7 开口 4 |

注意手稿这里量的是 **demo 价值**，不是技术价值——HA executor 本身仍是 onboarding 序列的一员（[`v3/10-executor-onboarding.md`](v3/10-executor-onboarding.md)）。

## 7. 遗留开口（带触发条件）

| # | 开口 | 内容 | 触发条件 |
|---|---|---|---|
| 1 | FastBrain 与 Surrogate 职责是否合并 | 未来 FastBrain 同时判定「是否说话」＋「说什么」，吞掉 Surrogate 的裁决职责（手稿「Ours v1 → 强化 Clarify 能力」行的真实所指）<br><br>*（2026-08-08 讨论追加，非手稿内容）* 障碍不在多源接入——两个端口共享同一个 ContextView、只差 prompt（[`v3/03-context-view.md`](v3/03-context-view.md)），handoff 以结构体字段而非对话轮次到达。障碍在**唤醒经济学相反**：FastBrain 在延迟路径上，用户输入特意绕过 Surrogate 以免每句话多付一次调用（[`essence.md`](../essence.md)）；Surrogate 在成本路径上，且成本已被 D11 登记为无法降低。**张力**：D11 的补救是拆出 `WatchView`（[`v3/08-deferred.md`](v3/08-deferred.md)），近期工程压力把两端推得更远，而尺子预言终将合并——拆的是 view、合的是决策，但这需要论证，不能默认。 | Ours v1 的 Clarify 强化验收之后评估；届时按惯例走 R 编号。<br><br>另需并看 D11 自身的触发条件（Surrogate 换端上小模型，或延迟成为指标）——若 `WatchView` 先落地，合并的前提要重新评估 |
| 2 | Memory × Channels 控制面挂载 | Memory 以控制面身份接入 Channels/黑板 | `memory-realtime-bridge.md` 进入实现（memory-candidates 推荐为下一份 spec） |
| 3 | 真全双工模型选型 | Seed Realtime / MiniCPM-o 4.5 vs GPT-Live 实测 | H 阶段起步、需要真双工底座时 |
| 4 | 简单 MCP 执行器的 demo 价值 | 信息查询类是否值得进 demo | 下一轮 demo 选题时判定 |
| 5 | 手稿残留字迹 ⍰ | 「3⍰ 语境上下文」前缀、「慢（逐句递进⍰）」、TML 行括号注记原文、「简单 MCP（信息查询/⍰）」第二项 | 用户翻原件自补，改本文即可 |

## 8. 被否掉的选项（引用既有结论，非本文新决策）

| 选项 | 出处 | 为何否 |
|---|---|---|
| 单选枚举 `<response>/<silent>/<delegate>`（JoyAI／0724 手稿形态） | [`v3/04-ports.md`](v3/04-ports.md) | 无法表达「同时 delegate ＋ 回答」；拆成两轴后九种组合皆合法，无需非法组合校验表 |

---

对外叙事版（英文、工程师文体、真实组件名）见
[`2026-08-proactive-voice-agent-design-space.md`](../blog/2026-08-proactive-voice-agent-design-space.md)。
