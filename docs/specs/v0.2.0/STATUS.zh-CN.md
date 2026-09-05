# v0.2.0 进度说明（给同事 review 用）

> 日期：2026-09-05 · 分支：`v0.2.0dev` · 当前基线：`fd16c5a`（工作区仍有桌面能力修复）
> 这份文档用大白话讲"我们做到哪了、怎么验的、接下来干什么、想请你们拍板什么"。
> 细节以各卷 spec 和 [`IMPLEMENTATION.md`](IMPLEMENTATION.md) 为准。

## 一、这个版本在做什么

Nova 是一个语音助手（前台是通义 Qwen 实时语音模型）。v0.2.0 的核心目标是：**让用户开口就能可靠地让 Codex 干活**——从"帮我把登录页那个 bug 修一下"开始，到必要的追问、生成工作单、审批、执行、看到结果，走通一整条链，并且中途不会因为模型"自作主张"而做错事。

后续再扩到：私人知识库（M4）；能力注册表与 MCP（M2、M3）已有代码实现，仍需 live 验收。

## 二、里程碑总览

| 里程碑 | 一句话 | 状态 |
|---|---|---|
| **M1** 一条完整的编码体验 | 提任务 → 只问必要的问题 → 工作单 → 审批 → 执行 → 看到结果；三平台统一审批策略，可选 YOLO | ✅ 代码 + 单测完成；真人语音/耳机、Windows 验收仍待做 |
| **M1.5a** 执行器边界（spec 07） | Codex 变成一个真正的"插件"，核心代码不再认识 "codex" 这个词，只认角色（coding）；用 lint + 脚本强制 | ✅ 完成并经独立 review |
| **M1.5b** 项目 / 会话 / 任务（spec 08） | 阶段性三工具前台；"在哪个项目、开不开新会话、停哪个任务"由编码执行器自己判断；支持多项目并发；显式取消；会话有可读标题（阶段性 surface 已被 M1.5c 取代） | 🟡 代码与测试完成，三轮 review 的已知阻断项均已修并带测试；语音端到端与并发审批真机未验，**不勾**（见第四、五节） |
| **M1.5c** 前台变薄（spec 03 / 07） | 默认六工具面；Camera MCP + side-VLM 投影；Vision controller 持有隐藏 `watch` / `guard`；监控由宿主策略驱动；桌面发布依赖闭包包含 MCP SDK 及其传递依赖 | 🟡 代码与定向确定性覆盖已完成；旧 08 live 行、真人语音、macOS camera、Windows 与完整发布验收仍待做 |
| **M2** 能力注册表（spec 03a） | `capabilities.json`、模块开关、MCP 搜索可选接入 | 🟡 代码/定向测试完成；live Search 仍待验 |
| **M3** 外部 MCP（spec 03b） | 用户自配 MCP 服务器接入，并投影到 Codex | 🟡 代码/定向测试完成；live 与发布验收仍待验 |
| **M4** 知识库（spec 04） | 本地 SQLite 私人知识库 + 混合检索 | ⬜ 未开始，是否随 v0.2.0 发布待定 |

## 三、最近两天干了什么（07 + 08）

### 3.1 为什么要改设计

原来的方案里，语音模型要看着一份"项目名单"，自己决定调 `列项目 / 选项目 / 建项目 / 开会话 / 续会话 …` 六七个工具。问题是：

- 实时语音模型每多一次工具调用就多一次可听见的停顿，"改一下博客"这种最常见的话要来回两三次；
- 工具越多、参数越多，语音模型越容易选错项目或编造 id；
- 以后接第二个 agent（比如 AutoGLM）时，这套东西要再来一份。

参考 qwen-audio-agent 的做法，我们把"前台"做薄、把"编排"下沉：

### 3.2 现在的样子

**当前默认 Nova 前台工具面为六个**（五个宿主工具加内置 Camera MCP）。用户显式启用的外部 MCP 工具可在此基础上增加，并受能力注册表的前台工具预算约束；不会静默截断：

| 工具 | 什么时候用 | 例子 |
|---|---|---|
| `dispatch(executor, instruction)` | 用户要某个 agent 干活 | `dispatch("codex", "改一下博客的暗色模式")` |
| `cancel(executor, instruction?)` | 用户要停 | `cancel("codex", "取消博客那个")` |
| `confirm(id, accepted)` | 用户对宿主提的是/否问题作答 | 建项目确认、Codex 权限审批都走这一个 |
| `memory__recall` | 查找已有记忆或历史进度 | 回忆上次关于某项目的结论 |
| `search__search` | 直接执行当前启用的搜索 | 搜索一个外部资料 |
| `mcp__nova_camera__snapshot` | 请求一张当前摄像头快照 | 看看桌面上是什么 |

隐藏的 `watch` / `guard` 不在前台工具表里，只能由 Vision controller 通过
`dispatch(executor: "vision", ...)` / `cancel(executor: "vision", ...)` 路由。

### 3.3 M1.5c：前台变薄后的真实边界

- `StructuredState` 及其 `update_intent` / `update_goal` /
  `update_authorization` 更新工具已从前台退役；旧的 `updateExternal` /
  `ContextView.structured` 也不再是模型状态写入口。编排事实由 WorkOrder、
  intake revision、宿主 FSM 和 approval controller 分别持有。
- Camera、watch、guard 不再各自占用前台工具名。Camera MCP 是内置、进程内的
  直接工具；Vision controller 统一拥有隐藏 `watch` / `guard`，并且 camera
  模块关闭时三者一起从 assembly 消失。
- 监控是 policy-driven：采样节奏、唤醒优先级、side-VLM 调用策略和投递方式
  由宿主决定，模型输出不能修改这些策略。side-VLM 只得到一张已存储图片和
  有界目标，Qwen 只得到 observation、时间、尺寸和 `evidence_ref`。
- AgentController registry 在编译前闭合，公开 agent descriptor，通用地拥有
  `dispatch` / `cancel` 路由并映射到唯一的隐藏 channel owner；coding intake
  仍是 coding controller 的私有实现，不把它扩写成所有 agent 的公共契约。
  不存在让语音模型直接调用 `watch` / `guard` 的路径。
- 非 agent 的外部 MCP direct path 已按用户显式 allowlist 装配；额外 MCP 工具受注册表
  预算约束，并可按同一 allowlist 投影到 Codex。
- 桌面 package contract 已按 MCP SDK 的固定版本和锁文件解析出的传递闭包登记；
  这是精确 allowlist，不是放宽成任意依赖，原有 forbidden media/camera 规则仍然有效。
- 最后一轮 whole-branch review 的三个 Important 已闭合：Camera snapshot 的
  `sync_result` 在同一次 provider function 调用中返回受限文本结果（成功字段闭合，
  失败精确保留 code 为 `vision_description_unavailable`），且不会补写 late fact；
  permission 的 late grant
  在 `armed`、snapshot、side-VLM、hit 之前都有同步 fence，未绑定的 raw hidden
  start 直接 fail-closed；production camera gate 现在是
  `env → Settings/registry → assembly`；环境覆盖优先于 registry 设置。

本节的“完成”仅指代码和已通过的确定性定向覆盖（工具面、camera gate、Vision
隐藏 channel、monitor policy、state retirement、package/release closure）。root
`npm run check` 与定向覆盖本轮已复跑并通过；但不把
确定性通过冒充成真人语音、macOS camera、Windows 或 live 完成。

**编码执行器内部的 intake（跑在便宜的文本模型 `qwen-flash` 上）负责决定**：

- 这句话是要**干活**、**追加要求**给正在跑的任务、**取消**、**切换**项目、**新建**项目，还是**没听懂**；
- 在哪个项目做（只能从已知项目名单里精确匹配；说了名单里没有的名字，要么明确是"新建"，要么反问）；
- 会话只有两种：`latest`（接着上次）/ `new`（重开一个），用户不需要知道"会话 id"。

**安全边界（重点，请 review）**：

- **任何改变"当前项目"的操作都要用户确认**（产品定的口径，2026-09-04）：明说"切到 X"、顺带切换的"改一下 X 的 …"、新建项目，三种都先由宿主提出确认问句，用户 `confirm` 之后才切/才建/才派。只有"在当前项目里派任务"、"给正在跑的任务追加要求"、"取消"不确认。确认提交发生在 intake 的 `committing` 状态里，用户这时的改口不会被当成答复，也不会有半路切一半的状态。
- 选一个**非当前**项目时，模型还必须引用用户原话里的那段话作为证据，这段话必须**只**对得上名单里的一个项目名（`pricing` 同时对得上 `pricing-page` / `pricing-svc` 就不算）；否则宿主当作"没听懂"去反问"是在 X 里做吗？"，用户说"对"才算。这是确认之前的第二道闸，**目的：模型不能靠猜切项目，即使猜对了也得用户点头。**
- Codex 的权限审批（越权命令、联网等）照旧要用户确认；同一时间只有一个审批"可听见"，其它排队。被项目确认问句遮住的审批**暂停计时**（不会 60 秒后被自动拒掉），项目确认结束后重新计满 60 秒再问。队列有上限：总共 3 个、每个任务 1 个，超出的直接拒。
- 语音模型本身**没有任何路径**能直接启动 Codex（隐藏的内部工具名从 provider 入口被拒）；`dispatch` 和 `cancel` 都要求绑定到用户刚说过的那句话（防模型自发调用）。
- 所有会产生副作用的 coordinator 分支都先检查用户是否明确要求执行；即使模型把状态提问错判为 `steer` / `cancel`，宿主也不会把问句发给 Codex 或停任务。
- 模型解析"停哪个"的期间用户改口了，不会停错：coordinator 路径同时看 intake revision 和待识别语音标志，显式 `cancel` 工具路径还看桌面独立送达的 `local_speech_onset`，不受串行 provider 接收循环阻塞。

**并发与体验**：

- 每个项目同时只跑一个任务，全局最多 3 个；再派就得到 `busy_project` / `capacity` 的明确回复，语音模型据此告诉用户"可以追加要求或先取消"。
- 会话标题由宿主从第一句话生成并写进 Codex（`thread/name/set`），不再是"任务 1 / 任务 2"。
- 桌面端：审批弹窗带"哪个项目 / 哪个会话在问"；“项目与结果”入口展示项目名单和正在跑的任务标题，并按 work_id 保留各任务结果；选择一项后查看原生结果详情，关闭进度气泡也能访问。
- 非实时的"文本前脑"（`GatewayFastBrain`）已删除：v0.2 的编码能力只走 Qwen realtime 路径。

## 四、我们是怎么验的

**当前确定性 validation（2026-09-05）**

| 套件 | 结果 |
|---|---|
| root `npm run check`（typecheck、lint、env contract、Node parity、executor boundary） | 全绿；Node parity 审计 206 files / 344 occurrences，executor boundary 15 allowlisted |
| runtime 完整套件 | 2250 total，2245 pass，0 fail，5 skip |
| runtime fixtures | 19 场景通过 |
| 定向 desktop capabilities 覆盖 | 68/68 pass |
| desktop 完整套件 | 843 total，840 pass，0 fail，3 Windows skip；source startup smoke 未运行 |
| CLI | 21/21 pass |

这些是确定性验证结果。`M1.5c/live/Windows acceptance remains pending`：真人语音
`dispatch` / `cancel` / `confirm`、macOS camera permission/side-VLM live、Guard
抢话/preemption live、耳机与并发审批、macOS 物理摄像头、真人 10 条脚本及
Windows 仍待验，M1.5c 总体发布门尚未完成。

本轮 live/设备证据也不能扩大上述结论：Qwen 实时 smoke 仅收到 3 个音频 delta，
证明连接成功（工具为空），不等于真人语音验收；Electron capability-status
fake-loopback 两个分支通过；预算超限现在无 readiness timeout、无重连，以配置错误
退出。固定视频 Camera Electron smoke 已通过（修复了 runner 的 ready 死锁、CSP
和 seek 同步问题），固定 PNG 也通过真实 Camera MCP → MediaStore →
`qwen3-vl-plus` 旁路描述，结果为 `untrusted_external`。这些不包含物理摄像头权限。
文件 oracle 覆盖首末参考帧及采样差异，不宣称逐像素证明中间帧身份；42 项 mutation
runner 本轮未重跑。Search MCP 初始化实测 HTTP 404，原因尚未确定，默认保持 Tavily。

沙箱内出现过的 desktop `EPERM` / `SIGABRT` 属于环境性问题；沙箱外已对同一
desktop 套件精确复现并通过。这里不把它冒充真人语音、物理摄像头或 Windows
验收；MCP 搜索仍是显式 opt-in，不能宣告 Search flip。

**旧 08 确定性测试（M1.5b/08 历史基线快照；不是 M1.5c 当前验收）**

下表数字来自旧的 08 验证快照，仅保留作为历史证据；M1.5c 当前验收以
上面的 validation 表和 live pending 边界为准。

| 套件 | 结果 |
|---|---|
| `npm run check`（类型、lint、环境契约、Node 平台一致性审计、执行器边界脚本） | 通过 |
| runtime 单测 | 2057 个，2052 通过，5 跳过，0 失败（2 个平台跳过；本轮进程没有 DashScope key，3 个 live eval 跳过，既有 live 证据见下） |
| desktop 单测 | 810 个，807 通过，3 平台跳过，0 失败 |
| cli 单测 | 18 通过 |

**Live 验收（M1.5b/08 历史证据；M1.5c 尚未重跑，证据在 `IMPLEMENTATION.md` "Live acceptance"）**

- coordinator 决策 eval（真实 `qwen-flash`，已写成测试，有 key 时随套件一起跑）分两组：
  - **开发集** 10 条（接着做 / 切项目 / 重开会话 / 新建 / 名单外名字 / 追加 / 取消 / 歧义 / 纯提问 / 只切换）。prompt 就是照着这 10 条调的，所以它的 **10/10** 只说明"调好了"，不是独立证据。
  - **holdout** 10 条（prompt 冻结后才写、没用来调：口语填充词、ASR 把连字符念成空格、句内改口、前缀重名、状态提问、英文）。5 次运行 **8 / 超时 / 7 / 9 / 7**，门槛 ≥7。两个系统性失分：①"博客那个跑完了吗？"被判成 `steer`，现在会被宿主的 intent gate 拦下，不再发给 Codex；语音模型层仍应直接从上下文回答而不调工具；②"pricing 那边的测试跑一下"在 `pricing-page` / `pricing-svc` 之间随机选一个。另有 2 次模型编造证据（"重新开个会话"被配上"博客"），被宿主的唯一证据校验 + 项目确认拦下。安全边界由宿主确定性逻辑保证，prompt 准确率只影响体验。
  - `resolveCancelTarget`：两个任务同时在跑时，"取消博客那个"选中正确。
- 真实 Codex 0.152.0：走项目适配器跑了一个真任务——标题写入被接受并回传、`cancel` 恰好一次 `turn/interrupt`、拿到 `cancelled` 终态、`thread/list` 能看到带标题的会话。顺带修了三处只有真机才暴露的兼容问题（schema probe 需 `--experimental`、`initialize` 需 `experimentalApi`、yolo 下 `permissions` 返回 `null`）。

**独立 review**

- 07 和 08 各做了一轮独立 code review（不同模型）。08 那轮找出 4 个阻断 + 3 个应修，全部经人工核实后修复，每条附测试。
- 同事第二轮 review（2026-09-04 上午）又发现 3 个 P1 + 3 个 P2，全部核实成立：切换项目的提交窗口仍有竞态、`cancel` 工具路径漏传改口检查、证据"唯一匹配名单"没有宿主保证、被项目确认遮住的审批会 60 秒超时自动拒、审批队列无上限、agent 契约是 Codex 特例、文本前脑拿不到新工具。本轮处置：切换改为必须确认（同时消掉竞态）、其余逐条修复并补测试、文本前脑删除。**所以上一版这份文档里"阻断项现在没有了"的说法撤回**；正确的说法是：已知的阻断项都有修复和测试，但语音端到端和并发审批真机还没验，08 不勾。
- 第三轮 review（2026-09-04，基于 `1ec5e66`）确认 2 个 P1 + 2 个 P2：显式 `cancel` 的改口测试绕过了生产串行接收循环；状态提问错判成 `steer` 时会真的追加给 Codex；agent `run` 可以声明宿主不会提供的额外必填参数；审批恰在 deadline 时可能被 `hold()` 复活。四条均先复现失败，再做最小修复并补回归测试；08 仍因 live 项未验而不勾。

## 五、还没做 / 已知缺口

| 缺口 | 说明 | 影响 |
|---|---|---|
| **语音端到端** | DashScope 实时语音真的按新说明调 `dispatch / cancel / confirm`，还没在真人语音会话里验过 | 08 验收的关键一行；需要人戴耳机跑脚本 |
| **M1.5c surface rerun** | 六工具和 Camera/Vision 的确定性覆盖已有；08 中适用的真人语音行尚未按新 surface 重跑 | M1.5c 发布验收仍未闭合 |
| 并发审批 | 两个任务同时向真 app-server 要审批、排队顺序 | 只有单测覆盖 |
| 新建项目全流程 | 语音说"新建 X" → 确认 → 目录真的建出来 | 只有单测覆盖 |
| Electron 桌面 smoke | capability utility 与固定视频 Camera smoke 已通过；source startup smoke 本轮跳过 | 物理摄像头与已安装产品验收仍待做 |
| yolo 模式 live | 修了 `permissions: null` 后没重跑真机 | 低 |
| 桌面项目名单 | 已通过现有项目与结果入口展示，双项目和独立结果有确定性 UI 覆盖 | 实现已补齐；不替代真人验收 |
| 别名 | 用户说"博客"、项目叫 `blog` 会被反问一次（"是在 blog 里做吗？"），这是有意保守 | 体验上多一句话 |
| coordinator 模型的系统性失分 | 状态提问被判成 `steer` 时由宿主 intent gate 阻止副作用；前缀重名和编造证据由唯一证据校验 + 项目确认拦下。安全有兜底，但回答体验仍不理想 | 下一版 prompt 要针对状态提问 / 前缀重名修，并换一组新的 holdout |
| Windows / 耳机 | M1 起就挂着的真机验收 | 发布前必须 |

## 六、下一步计划

**第一步：M1.5c / 08 收尾（建议 1～2 天，需要真人）**

先按新六工具面重跑适用的 08 真人语音行，再补 headset、并发审批、macOS
camera、Windows 和完整发布验收；当前定向确定性测试通过不替代这些 live gate。

真人语音验收脚本（每条记录转写、工具调用、结果）：

1. 在当前项目里说一个明确任务 → 应直接 `dispatch`，无追问，Codex 开跑，桌面出现进度。
2. "改一下 <另一个项目名> 的 …" → 听到"准备切换到 X 并开始任务，请确认" → 说"确认" → 切过去并开跑；说"不用了" → 什么都不发生。
3. "先切到 X" → 听到确认问句 → 确认 → 只切换不派任务。
4. "新建一个项目叫 X，做 …" → 听到确认问句 → 说"确认" → 目录建出来并开跑。
5. 任务跑着时说"顺便把 … 也改了" → 追加到同一任务，不新开。
6. 两个项目各跑一个任务，说"取消博客那个" → 只停那一个。
7. 触发一次越权审批（比如让它联网） → 听到审批问句 → 拒绝 → Codex 收到拒绝继续。
8. 审批问句还没答时说"新建一个项目叫 Y" → 先答项目确认，再听到审批问句重新出现（没有被自动拒掉）。
9. 说一个名单里没有的项目名但不说"新建" → 应反问，不能自己建也不能乱切。
10. "博客那个跑完了吗？" → 语音模型直接从上下文回答，不调工具。

加上：有桌面的机器上跑 Electron smoke；针对状态提问 / 前缀重名出第二版 assess prompt 并换一组新 holdout。

**第二步：M2 能力注册表（spec 03a，代码已落地）**

- `capabilities.json` + 桌面模块开关（搜索 / 摄像头 / Codex / 知识库）；
- MCP 搜索提供方（百炼 / DashScope）作为可选接入，Tavily 保留；
- 默认前台六工具 + 用户显式 MCP 工具；显式 MCP 工具计入注册表配置的前台预算，
  超预算 fail-closed。Search 默认仍为 Tavily，**先 live 验证再翻**（03a-flip 是单独一步）。

**第三步：M3 外部 MCP（spec 03b，代码已落地但 live 待验）**，然后 **M4 知识库（spec 04）**。

## 七、想请大家拍板 / 重点 review 的点

第一轮 review 已定（2026-09-04）：编排下沉到执行器 ✅；会话只有 `latest / new` ✅；**任何改变当前项目的操作都确认** ✅（原稿"切换不确认"作废）；并发 1 + 3 作为首版默认 ✅；别名保守反问 ✅，以后可加用户显式维护的确定性别名，不交回模型模糊匹配；M4 不阻塞 v0.2 ✅；文本前脑删除 ✅。

仍开放：

1. **Agent 契约**：AgentController registry 统一拥有公开的 `dispatch` / `cancel` 路由；coding intake 仍是 coding controller 的私有编排实现。非 agent 的 MCP direct path 已按用户显式 allowlist 装配，并可投影到 Codex。接 AutoGLM 前再评估是否把更多 executor 端口（roster / running / resolve）抽成通用契约。
2. **发布门槛**建议定为：M1.5 全绿 + 真人语音链路（上面 10 条）+ 并发审批真机。M2/M3 不作为 v0.2 发布前置？
3. **holdout 的两类系统性失分**（状态提问→steer、前缀重名）：安全副作用已由宿主兜底；是接受当前模型体验，还是要求 prompt 第二版把 holdout 提到 ≥9/10 再进真人验收？

## 八、相关文件

- 总纲与里程碑：[`00-overview.md`](00-overview.md)
- 执行器边界：[`07-executor-boundary.md`](07-executor-boundary.md)
- 项目 / 会话 / 任务：[`08-project-and-work.md`](08-project-and-work.md)（文末有 live 验收清单，未勾的就是第五节的缺口）
- 实现台账与全部验证证据：[`IMPLEMENTATION.md`](IMPLEMENTATION.md)
- 关键代码：`runtime/src/work-tools.ts`（三个工具）、`runtime/src/executors/coding/intake.ts`（coordinator）、`runtime/src/executors/codex/adapter-project.ts`（并发槽 / 取消 / 标题）、`runtime/src/realtime/service.ts`（拦截与 `confirm` 分流）
