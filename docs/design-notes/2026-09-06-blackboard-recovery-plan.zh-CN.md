# Nova 会话恢复与可替换长期记忆

状态：blackboard 持久化、恢复与清除已实现并有本地回归；本文保留原设计及验收边界。

## 已确定的边界

短期描述有效期，不描述进程寿命。Nova 自己保存近期会话记录和摘要；VoiceMem、mem0 等后端负责长期个人记忆。关闭或更换长期后端，不能破坏基本会话恢复。

| 内容 | 重启后的处理 | 所有者 |
|---|---|---|
| 最近对话、目标描述、关键进展、结果、证据引用 | 在保留窗口内恢复，可讨论和查询 | Nova blackboard |
| 摘要 | 连同来源覆盖范围、有效期一起恢复 | Nova blackboard |
| 曾在执行的任务、待确认操作、临时授权的历史描述 | 显示为历史，当前状态待核实 | Nova 历史投影 |
| 任务实例、事件队列、模型作业、确认能力对象、临时授权 | 不反序列化，不重新调度 | 当前运行进程 |
| 个人事实、偏好、稳定倾向及学习结果 | 经统一个人记忆端口访问 | 可替换后端 |
| 项目身份、别名、关系 | 继续由 graph 提供；不代替完整任务结果 | Workspace graph |

记录保留原始出处和信任分类，但历史用户发言不是新一轮指令。当前用户可以要求继续历史任务；此时以新的用户回合重新进入既有执行与确认流程。

## 代码审查发现

- `runtime/src/memory.ts` 目前只有内存数组，序号由 `items.length + 1` 生成。保留策略会产生序号空洞，因此不能再用数组长度分配序号，也不能裁剪后重新编号。
- `runtime.ts`、`realtime/recall.ts`、`realtime/service.ts` 存在 `items[seq - 1]` 或以序号作为 `slice` 下标的读取。必须一起改成按稳定序号解析，不能只改存储。
- `RealClock.now()` 使用 `performance.now()`。现有 `MemoryItem.ts` 是进程时间，跨进程 TTL 和排序要使用另外持久化的墙钟时间与记录顺序；`realtime/recall.ts` 的候选及命中排序也在修改范围内。不要伪造历史进程时间来掩盖时间轴差异，墙钟回拨时用持久化顺序保证确定性。
- 写入不全经过 `CoreRuntime.#appendMemory`；assembly 的 intake 也直接调用 `memory.append`。摘要又在 runtime 中直接赋值。持久化边界必须覆盖这几条入口。
- `context-view.ts` 会从未知结果生成 probe，从“新鲜”记录生成 update。恢复历史不能重新生成这些自动动作。
- `realtime/memory-board.ts` 已直接从 Memory 生成 Board，界面不需要独立数据库。
- `CausalRuntime` 的用户回合授权与确认能力对象是进程私有状态；保持如此。还需在 core 的 action origin 校验中显式拒绝历史 origin，不能只依赖对象没有恢复。

## 存储与恢复合同

采用 Nova 自有、有界的记录存储，复用项目已有 `node:sqlite` 能力。不给这个单一存储再添加可替换 provider 注册框架；长期后端的替换接口仍然独立。

持久化内容包括 conversation scope、channel、稳定序号及其高水位、原始 MemoryItem、入库墙钟时间、摘要及其覆盖区间和修订。持久化完整允许保留的任务结果和 evidence refs，不存 Board 中截断后的展示字符串。已有内容边界和敏感信息规则继续适用。

同一 conversation 重启沿用稳定标识；“新会话”创建新标识，“清除近期记录”提升清除代次。不同会话和不同本地用户隔离。默认 scope 字符串不能直接成为多个实际会话共用的数据库命名空间。重新连接音频 provider 不等于新会话。

启动先读取、校验、裁剪记录，再直接 hydrate Memory，最后启动实时服务。不能回放旧 EventRecord 或调用旧事件的 reducer。缺失的 executor channel 可作为只读历史显示，但不能据此注册 executor 或执行策略。

恢复水位区分本次启动前后的记录；当前执行状态只来自当前进程。历史可以成为新任务的证据，不能成为自动 dispatch、probe、通知或审批的起点。保留既有 origin 合法性规则，再增加当前启动与清除代次校验；不能把当前进程合法的 monitor/system/handoff 因果来源一概改成只能由用户消息触发。需要用户授权的入口继续要求原有私有 authority。Board/模型上下文明确标注历史和待核实状态，不修改原来“当时正在执行”的事实记录。

### 提交与实时性

“已接受且可恢复”必须对应实际提交成功，不能只表示已放入 Worker 队列。磁盘错误不能悄悄退回内存后继续报告持久化成功。

优先保持现有 SQLite Worker 模式，在承诺 durable 的入口建立提交屏障，并核查相关模型/执行器副作用的启动顺序。当前 reducer 同步执行，不能把所有 `append` 改成 fire-and-forget 就认为完成接入。M1 必须先验证最小提交边界；若需要同步 SQLite 作为更小方案，必须先测真实写入与锁竞争对音频事件循环的影响，不能凭“小数据库”假定无阻塞。

M1 首选有序写入与提交水位，不搬迁整个 reducer：任务捕获 `(scope, generation, writeWatermark)`，执行前等待对应提交。仅在 `#ownTask` 中等待仍不够，因为同步 external admission 已经返回 accepted，外部响应也必须延迟到提交成功，或在此前明确为 pending。

| 写入入口 | 提交后才能发生 | 失败与代次边界 |
|---|---|---|
| 用户输入 / `serve` 事件 | ingress 成功返回、observer 发布、依赖它的模型调用 | 提交失败进入明确故障态，不启动依赖副作用 |
| 外部 dispatch / 确认 dispatch | 对外 accepted 响应、实际 adapter 调用 | 不提前报告 durable accepted；保留现有一次性 capability 消费语义 |
| assembly intake 直接记录 | 相关上下文发布与后续动作 | 纳入同一写入门面，不能绕过水位 |
| progress / observation / terminal result / deadline | 历史发布及相关后续动作 | delegate 绑定原代次，旧代次回写由事务 CAS 拒绝；控制层仍正确收束任务 |
| 摘要完成 | 新摘要可用于 Board / prompt / recall | 校验来源修订及代次；TTL、裁剪、clear 都使旧来源修订失效 |

压缩快照必须带明确的 source refs 或可验证的覆盖区间，不能继续仅凭 `snapshotCount` 判断覆盖范围。

本阶段不把该日志自动当作 mem0 的投递队列。以后复用来源时，另需后台消费水位、删除代次、远端请求回执和不确定结果处理；本地持久化不等于远端 exactly-once。

### 保留与清除

保留期限、总条数及字节上限同时有界；启动和运行期间均执行，不等重启才过期。具体默认值在 M1 用现有记录大小核定。不能仅靠 Board 的展示条数限制数据库。

摘要记录明确的来源覆盖范围。第一版采用保守策略：来源因期限、容量或用户清除而失效时，相应摘要也失效；新摘要不能通过重新生成时间延长已过期内容的寿命。若将来需要比原文保留更久的摘要，应单独定义并展示那种保留政策。

清除入口命名为“清除近期会话记录”，与“删除长期个人记忆”区分。清除在存储提交后同时失效 Memory、Board、摘要作业和有关上下文缓存；用代次校验拒绝晚到结果重新写回已清除内容。高水位或等价的引用命名空间不会回退，旧引用不能命中新记录。

清除不能隐式取消独立执行器任务，也不能继续把旧任务输出保存回已清除的会话。应切换会话记录代次，让旧任务保持在运行控制层，新的任务/进度绑定遵循明确的新代次规则；接入前以在途任务测试验证。已交付给模型的上下文也必须重建或重置，不能只删除 UI 数据。

## 实施 checkpoint

1. **M1：记录与提交。** 稳定 scope/序号、存储事务、墙钟、摘要覆盖、提交错误与容量策略；完成真实进程重启、强制退出和写入延迟检查，确定提交屏障。
2. **M2：安全恢复。** 启动 hydrate、历史标记、统一引用查找、action origin 隔离、禁用历史自动动作。恢复前后的 recall 保持正确引用和顺序。
3. **M3：保留与用户入口。** 运行中到期、条数/字节裁剪、Board 展示、清除及在途结果隔离。使用当前 desktop 控制通道的授权边界，不把只读 debug-board 请求改成隐式写接口。
4. **M4：与长期后端协同。** 验证 disabled/VoiceMem/替代后端测试资源均不影响会话恢复；之后再接稳定偏好快照与自动回复调整。仅为实际消费者增加端口方法。

每个 checkpoint 由 Terra/Sol review；提交边界与权限恢复设计交给 Claude xhigh review。最终走真实重启验收，不能以 standalone VoiceMem 测试替代 Nova 恢复测试。

## 2026-09-06 设计复审结论

完成 Sol 代码审查、Terra 计划与提交水位复审，以及本地 Claude CLI `claude-fable-5-1` / `xhigh` 的专项架构复审。Claude 本轮输入为计划约束及相关代码，未包含密钥或用户记忆；结果保存在本机 `/private/tmp/nova-blackboard-architecture-round3.json`，临时文件不作为仓库依赖。

三方一致确认序号、进程时间、历史 origin 和摘要覆盖是恢复前必须处理的问题。外部建议经代码与用户要求核对后取舍：

- 采用 Worker 提交水位作为首选，并覆盖同步 external admission 的对外响应。没有采用“写入失败后继续正常接受但只保留内存”的建议，它会模糊已接受记录的恢复承诺。
- 保留记录和摘要一致的保守过期政策；不采用未经产品明确区分的“原文过期、摘要继续保留”。摘要只带生成时间与结束序号不足以验证来源有效性，仍需覆盖信息及来源修订校验。
- 清除不自动 abort 所有 task；在途任务的控制生命周期与历史回写分开。具体完成通知仍按当前执行层处理，旧正文不能回灌被清除会话。
- 不把超限的完整任务结果静默替换为 stub 并宣称恢复完整，也不将 recall 的扫描上限直接当作全库保留上限；存储、查询和展示分别受界限约束，截断须可见。
- 不为第一版增加序号块预留或通用 dispatch ledger。提交后才公开稳定引用；历史不确定执行必须提示待核实，重新执行经过当前请求和既有安全流程。若后续需要跨启动阻止某类重复副作用，应围绕该具体执行器补充可对账的持久记录，不能从历史文本重建 live delegate。

上述设计复审本身不代表实现完成。

## 引用与裁剪前置 checkpoint

已在独立 worktree 落实内存层前置修复：channel 序号不再依赖数组长度；裁剪保留序号高水位，runtime、recall 和 progress 投影按真实 seq 找记录。摘要记录覆盖水位与来源保留修订，来源裁剪或覆盖倒退会拒绝旧结果；未压缩数量按实际剩余记录计算。压缩调度只使用现有 channel backlog，移除重复的 SlotSet pending 排队，跳过已裁空的来源。

Terra 复核通过。回归先复现了 retained origin 查找失败、recall cutoff 错位、迟到摘要恢复被删内容、空压缩和摘要覆盖倒退，然后修复。最终完整 runtime 测试为 2341 项：2336 通过、5 跳过、0 失败；`npm run check` 通过。证据分别在本机 `/private/tmp/nova-blackboard-phase0-full-tests-final.txt` 与 `/private/tmp/nova-blackboard-phase0-check.txt`。

首次全量测试与 `check` 并行时，后者内部的 env-contract 检查重建了 `runtime/dist`，造成 16 项 Worker 文件缺失失败；重建结束后串行全量重跑通过。后续 `check`、runtime 测试和 desktop 构建均应避免并行修改/消费该目录。

以上为前置 checkpoint 当时的范围，后续记录库与恢复实现见下。本 checkpoint 本身不能作为生产重启恢复验收。

## 记录库与恢复 checkpoint

新增 `memory/blackboard-store.ts` 与 SQLite Worker，使用现有私有数据库路径规则（提取到 `private-database.ts`）。提交采用事务及 FULL synchronous WAL；最新 revision、输入摘要与回执原子保存。重试 clear 先检查旧回执，再校验 generation，避免成功清除后因旧代次而无法确认重试结果。每个 client 固定 owner/conversation 和 host channel allowlist，只允许一个未回执操作；打开失败也会关闭 Worker。

每 scope 默认 7 天、1000 条、8 MiB 的逻辑记录与摘要预算；一个 scope 的策略不会删除其他 scope。owner 全局 10000 条/64 MiB 为拒绝写入的硬上限。逻辑字节不等于 SQLite/WAL 实际文件大小。128 个历史 scope / channel 名称是当前显式上限，clear 不回收 scope 元数据；在增加任意新会话 UX 前，仍需明确带重试回执保留期的退休策略。全局 channel highWater 不回退，恢复、过期和清除后均不能复用旧 ref。

`Memory` / `CoreRuntime` 可从校验后的 snapshot 构造记录投影，不回放事件。恢复的 trust 保留历史来源含义，统一 `historical_origin` 检查阻止普通与确认 dispatch 使用旧来源；recall 必须由本进程 user cutoff 发起。ContextView 不为历史记录生成 probe/update，并向模型说明历史运行状态需重新核实。缺失 executor 的 channel 只读。跨进程召回按持久 ordinal 排序，不拿旧 `performance.now()` 与当前时间比较；Board 在条目及通道级携带历史标识与可用的墙钟。

已用真实 SQLite / Worker 覆盖正常重开、SIGKILL 后恢复、原子回滚、clear 重试、旧代次拒绝、TTL/数量/字节裁剪、损坏记录拒绝，以及恢复后历史 origin 拒绝、新 origin 可用、历史 unknown 不自动行动。Terra 找到的跨 scope 泄漏、误删、失败打开泄漏及 Board 摘要缺少历史标识均已修复。

外部 Claude 首次关键审查返回空正文，不算通过；使用 `claude-fable-5-1[1m]` / xhigh 重试后取得正式审查（本机 `/private/tmp/nova-blackboard-store-claude-review-final.json`）。采纳关闭 drain、meta 单行约束、裁剪前校验摘要元数据及 source、保留原始回滚错误、摘要独立过期回执等修正。`close()` 阻止新请求，但等待已入站操作返回真实结果，再关闭 Worker；重复关闭共享同一个 Promise。旧摘要过期而原文仍在更长 TTL 内时，回执通过绝对 retentionRevision 和 `prunedThroughSequence=0` 表示仅摘要失效，接线层必须处理这一情况。

sidecar 权限收紧改为 `O_NOFOLLOW` 打开描述符后 `fstat/fchmod`，并以 `O_NONBLOCK` 防止非普通文件阻塞。这不宣称消除了 `DatabaseSync(path)` 的路径重开窗口；没有采用外部建议中“删除摘要到期处理”的做法，否则扩大原文 TTL 会错误延长旧摘要寿命。

验证证据：完整 runtime 回归 2355 项（2350 通过、5 跳过、0 失败），保存在 `/private/tmp/nova-blackboard-review-fixes-full-tests.txt`。随后补强两种损坏摘要的删除前校验，最终 focused 回归 27/27 通过（`/private/tmp/nova-blackboard-final-focused-tests.txt`），`npm run check` 通过（`/private/tmp/nova-blackboard-final-check.txt`）。Terra 已复核最后的 expires/source 检查闭环。所有测试使用临时记录；未新增 DashScope 抽取调用，未修改、提交或合并 Nova 主 checkout。

**该 checkpoint 当时尚缺生产接线。** 当时没有 `CausalRuntime` / assembly 启动落盘与恢复、运行期维护计时器或用户 clear 入口，不能声称应用重启恢复已完成。Sol 核查后确定 reducer 保持同步，公开 CausalRuntime dispatch 改为异步提交后返回；bridge/service、Intake、ProjectAdapter、Codex/Vision controller 均有现成 async 落点。实际模型调用还必须在提交后的裁剪结果上重建 ContextView 与 visible refs，不能发送提交前已缓存的旧内容。提交失败须阻止依赖副作用，并与模型/adapter 自身失败区分。

接线先采用具体 `BlackboardSession` 的有界状态差分，不额外给 Memory 注入第二份 mutation journal：比较每通道已提交 highWater 与完整摘要 tuple（text/throughSequence/retentionRevision），串行提交 append 后再提交 summary，只按本批实际发送内容推进游标。绝对 retention receipt 同时裁剪 Memory 和摘要游标；本地不能先删未提交 append。clear 为显式事务，不能从空数组猜测；运行期 TTL 走同一串行通道的空提交。任何新的 flush 请求都必须覆盖其到达时尚未提交的状态，不能简单返回一个只承诺更早状态的在途 Promise。

成功 admission 目前只进入 runtime 的 in-flight/effects，并没有 Memory record；接线时必须在启动 adapter 前增加有界的历史接收记录，保存 delegate/executor/op/origin 和必要摘要，不保存 capability。否则等待 flush 只能证明用户原文已落盘，不能证明任务接收事实可恢复。assembly 的 intake 直接 append 后需明确触发 flush，不能假定一定会有下一个 reducer event。正常关闭先停止新写入，再 drain，最后关闭 Worker；不能由任务关闭 grace 截断提交。

## 验收场景

1. 长期记忆关闭，记录一段对话和完整任务结果，重启后询问“刚才做到哪”，可取得近期内容及对应证据；无额外抽取模型调用。
2. 任务执行中或审批待确认时强制退出，重启后只有历史记录；无执行器调用、自动 probe、确认复用或临时授权恢复。
3. 已提交记录在强制退出后可恢复；提交失败不会被报告为 durable 成功，未提交记录不作恢复承诺。
4. TTL/容量裁剪造成序号空洞后，旧引用仍准确或明确不可用；新记录不复用旧序号；跨启动排序正确。
5. 摘要来源过期或清除后，Board、recall 和实际发送给模型的上下文都不再含该内容。
6. 压缩、召回和任务结果尚未返回时清除，晚到回调不能复活旧记录；独立运行任务不会因清除被暗中取消。
7. 重新连接同一会话不会丢历史；新会话、用户切换、缺失 executor 均不串数据或恢复能力。
8. 不可用、锁定或损坏的存储呈现明确恢复状态；故障和保留任务不造成无界队列或音频阻塞。

相关参考：[VoiceMem 接入经验](2026-09-05-voicemem-recall-integration-lessons.zh-CN.md)。Qwen 最新参考固定于 `439e81b8c3d09180011b7d3ea2b521472c4f6eac`；其同步 prompt 快照、异步 recall、单一后台学习所有者值得借鉴，但不替代 Nova 的记录恢复与授权边界。


## Runtime 提交与桌面接线 checkpoint

`BlackboardSession` 比较同一个 Memory 的已提交游标，按 256 mutations / 4 MiB 分批，回执后只推进实际发送的 append/summary，再应用绝对 retention revision。所有在途提交期间到达的 flush 请求均被覆盖；没有第二份事件日志或 optimistic 数据库。当前 drain 等写入静止才一起完成；高频独立 host writer 接入前须换成调用者水位，这是明确上限，不能宣称持续高负载下 ACK 延迟有界。

CausalRuntime 的用户 ingress、观察者发布、模型与 executor 启动均经过提交屏障；成功任务接收留下有界的 task_admitted 历史记录，不含 capability。公开 external/confirmed admission 改为 Promise，bridge、Intake、Codex、ProjectAdapter、Vision 随之 await。Executor 无论是否启用持久化，均在下一次 event-loop turn 启动，让调用者先安装 correlation。确认路径只有 recordRuntimeAdmission、claimConfirmed、binding 全成功后才释放 launch guard；普通 userTurn 在等待后再次核实，Vision 的并发 stop 共用 pending admission。

模型在提交后的 retention receipt 上重编 ContextView/compression 输入。Recall、Desktop Board 和受控 Guard provider-history 恢复同样 await flush 后同步投影；Guard 的最终 flush 放在取得两个 service lock 之后。恢复 hit 携带 historical 与 recorded_at_ms，编码计入预算并校验字段配对；共用前台指令要求重核运行状态与权限，并说明旧 ts 是进程时钟。task_admitted 的安全证据只表示“已接收”，不表示当前仍运行或已完成。

桌面 Node entry 显式从 NOVA_AUDIO_AGENT_BLACKBOARD_PATH / BLACKBOARD_OWNER_ID 配置启用，默认 ~/.nova-audio-agent/blackboard.sqlite / local；不依赖 memory_backend、VoiceMem Worker 或个人记忆用户 ID。Qwen/cascaded 透传相同 options；core.start 在 camera/provider 前恢复。当前宿主仅固定 default conversation，尚没有多会话切换 UX。运行期每 60 秒维护，显式 recall/Board 读取也先维护。

关闭先由 service 停止生产者，再在 transport grace 外等待 runtime serve finally/blackboard close。桌面强杀 grace 为 32 秒，覆盖两次 10 秒数据库 RPC、7 秒 Codex drain 与其他清理余量；这不是任意积压/硬件挂死的无限等待保证。provider 首次 connect 失败保留已打开的 core/blackboard 供原实例重试，provider-session 自己关闭失败连接；最终 stop 后，持久化 assembly 与 memory 拒绝重开，须重建实例。camera 启动失败仍由同一 owner 持有恢复资源直至重试或最终 stop。

Sol/Terra 分别复核提交分批、异步授权、历史编码、consumer barriers、启动重试与关闭上界；发现的问题按上述路径修复。外部 Claude CLI 首次在沙箱内联网失败，不能计为审查；获准联网重试 claude-fable-5-1[1m] / xhigh 后取得正式结果（本机 /private/tmp/nova-blackboard-runtime-claude-review-final.json，589519ms）。审查确认三条主要因果顺序成立，同时提出以下限制：单记录超限目前 fatal；payload schema 演进须迁移；Vision 对外 admission 错误较粗；共享 drain 在高频独立 writer 下可能推迟 ACK。

本轮没有采用把超限完整任务结果静默替换为成功 stub 的建议。单记录 256 KiB、摘要 65536 UTF-16 单元以及 quota 仍是明确失败边界，失败停止 runtime，不能称完整结果已恢复。若要改善大结果可用性，应先补可持久引用的完整 artifact 与显式缺失语义。当前未发布 v1 payload 的规范字节校验保留；未来增加 default 字段也必须连同 user_version 与 payload migration 一起修改，不能把旧行缺字段假设成已有旧版合同。Vision 的通用端口 catch 不引入具体 blackboard 错误类型；实际 storage 错误仍由 CausalRuntime fatal 路径关闭服务，细化 UI 错误归因仍可继续完善。

此 checkpoint 仍不等于全部集成验收完成：用户 clear 入口、clear 与在途压缩/任务回写的代次隔离、真实桌面语音端到端验收尚待完成。没有新增 DashScope 抽取调用，没有提交/合并 Nova checkout。


最终验证：完整 runtime 2372 项，2367 通过、5 跳过、0 失败（本机 /private/tmp/nova-blackboard-wiring-full-tests-final.txt，113233ms）；`npm run check` 通过（/private/tmp/nova-blackboard-wiring-check7.txt，226 files / 387 parity occurrences / 15 executor-boundary occurrences）。真实 SQLite 提交等待、容量失败、进程 SIGKILL 与重启 recall 专项 10/10 通过（/private/tmp/nova-blackboard-recall-final-test.txt）。桌面 backend 生命周期回归通过（/private/tmp/nova-blackboard-backend-drain-tests-final.txt）。

首次全量在限制 loopback/原生 sandbox probe 的环境中失败，获准在沙箱外串行运行后消除环境限制。新增夹具先后修正 provider connect identity、锁等待超过 SQLite 自身 1000ms busy timeout、未启用 recall schema，以及把 outcome=null 的“不确定结果”误当作成功正文；没有为这些夹具改动生产安全证据规则。模型可见历史提示的 outbound golden 仅增加了对应的一行。新增 Guard 锁等待回归证明先取得 service 锁再 flush，flush 未回执时不得建立替代 provider。

## 清除与回复偏好 checkpoint

Standalone VoiceMem-TS 的反馈闭环已推送为 `49d6a3f`（后续文档 `5e05457`）：独立 optional `previousAssistantReply` 保留原 `assistantReply` 同轮含义；Demo 等设备取消回执后只取紧邻上一条助手的已交付前缀，未听到或没有上一条回复时不回扫更早回复。当前用户 utterance 才是记忆证据。自动应用仅限 owner/self、同归属且 user-role 的 `reply_preference`，在现有 topK 与上下文字数预算内优先。Terra 与 Claude `claude-fable-5-1[1m]` / xhigh 的审查发现第三方偏好污染、零播放跨轮误关联和偏好被预算挤掉，均已修复并经独立复核；最终 standalone 228/228 通过。以上是确定性回归，不宣称新的 live 抽取质量验收；没有额外 DashScope 抽取调用。

Nova 的清除基础使用单一 Memory 和既有 SQLite clear transaction。Session 必须先 flush 包括尚未显式提交的 append，再提交 clear 并按 receipt 清空；否则 live highWater 与数据库时钟会分叉。Core 的 host-only epoch 与 WeakMap 标记不进入事件 schema；clear 清理模型槽、待处理唤醒与建议，保留执行器控制表，旧终态仅结算控制。旧 handoff 交给 host observer 时去掉正文/refs，并标记非当前会话；新模型 ContextView 排除旧代次运行任务，避免通过 in-flight request 重新带回被清正文。

外部 clear 架构审查（本机 `/private/tmp/nova-blackboard-clear-architecture-review-final.json`，429448ms）确认普通 service.close 会中止独立执行器，普通 reconnect 又会回放旧摘要与同步结果，因此两者都不能直接作为清除入口。当前接线采用受控 clear 流程：先 fence ingress、播放与投影，再 join 在途 ingress，平时保持 ingress 并发，clear 同步 fence 后 join 已登记的在途 handler，再按 reconnect/delivery 锁序提交清除与 provider reset；不播种旧 recovery snapshot。需要保留当前 workspace 身份，清掉会话任务正文。外部建议的“自动重开数据库推断提交结果”没有采用：当前存储错误继续走显式 fatal 边界，不增加新的失败恢复状态机。

桌面入口为 Board 专用主进程 IPC，经 native confirmation 后调用 utility `conversation.clear`；sender、零参数和确认期间的 backend owner/generation 均复验。普通 Board WebSocket 仍只读。UI clear 与刷新采用同一读取 ownership fence；旧读取不能在 clear ACK 后重画旧记录。主进程同步 dialog 异常的 single-flight 释放已修复，直接执行实际 handler 的 VM 回归与 Board UI 回归共 61/61 通过。Nova 生产 clear/session 接线与自动偏好上下文仍在全量验证中，未提交或合并此 worktree。


### 本轮实现审查与可复现依赖

- 自动回复偏好在 provider connect、音频发送及 host response/ensure 入口读取同步缓存。最终转录回调太晚：Cascaded 入队转录后立即启动 LLM，Qwen VAD 自动生成回复。ProviderSession 统一刷新；Qwen 替换独立 system item，Cascaded 使用每次请求读取的独立 slot，均不借用 workspace context 或一次性 dialogue history。内容相同只推进已确认版本；读取失败只去重诊断，后续仍可恢复。失败的同版本替换不逐帧重试。
- 已完整播报的上一回复在 user final caption 同步边界捕获，按 epoch/revision 在持久化接收后兑现一次。原文保留；零播放、打断、clear、重连均不能回扫旧回答。迟到 final 优先使用原 VAD item 的 ledger revision，避免关联后来播出的回答；缺少可靠对应时省略背景。
- 清除验收发现并修复两条生命周期问题：普通入口不可被全局互斥锁串行化，否则用户无法纠正等待中的取消；旧 provider stream 结束后必须 join 在途重连，再判断是否发生断线。Assembly 与 Service 的 single-flight 都在同步播放回调前建立，防止重入导致重复 publication。clear 失败保持 fence，同时进入既有 fatal service lifecycle，不留下貌似存活却静默丢输入的服务。
- 精简外部关键审查已返回：`/private/tmp/nova-clear-focused-review-final.json`、`/private/tmp/nova-m4-focused-review-final.json`。确认的失败生命周期、重复偏好网络确认和短暂读失败问题已修复；条件性 approval 死循环、旧 request 回流、未标记生产事件等经独立 Terra 读代码后未发现成立路径。一次过大的完整代码包未返回审查结论，已停止，不计为审查通过。
- Nova 依赖已推送的独立仓库完整 commit `5e05457121f50c7c1d044d8d0b7acdf85b3892d4`，不再依赖被本地忽略的镜像 workspace。Git dependency 安装必须执行 package 的 TypeScript `prepare`，不能使用 `--ignore-scripts` 后假定有 dist。npm 将 GitHub HTTPS spec 规范化为同 SHA 的 `git+ssh` lock；release lock identity 对两种格式校验完整 SHA 并纳入哈希，registry 包原身份不变。

上述修复正在最终 runtime/check/desktop 验证；以末尾最终记录为准。未提交、stage、合并或推送 Nova integration。


### 最终接线验收（2026-09-06）

本 checkpoint 的持久化恢复、清除入口、可替换个人记忆接口和自动回复偏好接线已完成，保留在独立 `feature/voicemem-nova-integration` worktree 供 review；没有 stage、commit、merge 或 push Nova 改动。Standalone `VoiceMem-TS` 已推送完整 SHA `5e05457121f50c7c1d044d8d0b7acdf85b3892d4`。

- `npm run check` 通过：226 files / 395 parity occurrences / 15 executor-boundary occurrences。证据：`/private/tmp/nova-memory-final-check2.txt`。
- 完整 runtime：2415 项，2410 通过、5 平台/既有跳过、0 失败。证据：`/private/tmp/nova-memory-final-runtime.txt`。
- VoiceMem Worker 与本地 HTTP fixture：20/20 通过，含真实 SQLite 和后台学习缓存通知；没有付费抽取。证据：`/private/tmp/nova-m4-memory-provider-tests-live-local.txt`。
- Desktop build 与依赖包检查通过；完整桌面测试 855 项，852 通过、3 平台跳过、0 失败。证据：`/private/tmp/nova-memory-final-desktop-tests3.txt`。Windows source-startup smoke 在 macOS 按既有平台条件跳过，不计为通过。
- Electron 43.2.0 真实 main/supervisor/utility child 验收通过：旧 user final 持久 admission、Board 可见、真实 control RPC 返回 `{cleared:true}`、替代 Qwen 连接、保留频道但记录/摘要为空、新 user final 可见、正常关闭。使用临时 HOME/数据库与 dummy HTTPS/WebSocket 服务，toolCalls=0、providerConnections=2。证据：`/private/tmp/nova-memory-utility-clear-live2.txt`。复跑命令（desktop package 目录，先 build）：`./node_modules/.bin/electron scripts/utility-runtime-smoke.mjs --capability-status --memory-clear`。

打包 whitelist 显式包含 VoiceMem，以及独立 package 的编译入口和 Nova store Worker；没有放宽原有原生媒体依赖限制。完整测试发现的旧 preload 能力断言已更新。原生 addon 测试在独立临时目录运行：原先测试从指向外盘的 build 软链接创建目录，被既有 canonical-path 安全检查正确拒绝；没有修改产品的路径安全策略。由于内盘空间不足，本 worktree 的可再生成 `desktop/ambient-orb/build` 指向专用外盘目录，运行本机 build 时须挂载该卷；源码和锁文件不依赖此绝对路径。

这些结果不替代真实麦克风/扬声器、Windows 桌面、代表性 LoCoMo/PersonaMem 质量、GPU 推理或付费 live 抽取验收。持久会话身份由宿主 owner 派生，临时会话各自独立；多会话 UX 尚未实现。mem0 适配器保留在源集成分支，暂不进入桌面包。上游 PR 尚未发布，须先由用户 review。长期记忆后端停用时，Nova 自有 blackboard 恢复与清除仍独立可用。
