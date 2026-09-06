# 三分支审查与 v0.2.0dev 合入路线图

> 日期：2026-09-06 · 基线：`v0.2.0dev` @ `fad6b10` · 状态：**仅审查与规划，未改任何产品代码**
>
> 摘要：本文记录对 `feature/chinese-wake-word`、`feature/voice-focus`、`v0.2.0dev` 三条线的独立审查结论、
> 已经拍板的处置决定，以及把前两者合入 `v0.2.0dev` 的分阶段路线。审查方式：六路只读静态审查（两条 feature 线各一路，
> v0.2.0dev 分运行时架构 / 桌面与流程 / 知识库 M4 / Windows 四路）加人工复核关键发现；未运行任何分支的合并，冲突分析基于
> `git merge-tree --write-tree` 的干跑结果。门禁与测试实测结果见第 4.1 节。标记：✔ 已由本轮人工复核；◦ 仅来自静态审查。

## 0. 结论速览

| 线 | 现状 | 结论 | 合并/发布前必须处理 |
|---|---|---|---|
| `feature/chinese-wake-word` | 分支上 **0 个 commit**，全部工作为 worktree 内 29 个已改文件 + 6 个未跟踪路径 | **可合并，需先修** | C1 下载中断泄漏、I3 隐藏失效、I2 冗余 ack 门控、I6 心跳无测试；spec 改为 `11-` 并重写为英文 |
| `feature/voice-focus` | 2 个成型 commit，worktree 干净，基于 `4b90c99` | **分支本身质量高；与 dev 合并有 4 处语义断裂** | 2 处文本冲突 + 2 处 git 自动合并却编译失败的断裂；另 4 项 Important 一并处理 |
| `v0.2.0dev` | 领先 `main` 92 commit，**91 个未推送**（`origin/v0.2.0dev` 停在 9 月 3 日 `2cb2104`）；本机门禁全绿 | **spine 与 provider 边界健康；发布前有 6 项必修** | executor 边界未被证明、知识库 `stale` 合同断裂、桌面退出可挂死、设置事务无回滚、91 commit 零 CI 覆盖、Windows 只有数据层面验证 |

## 1. 分支拓扑与现场事实

### 1.1 提交拓扑

```text
9763e50  fix: share external MCP quota across same-origin calls     ← feature/chinese-wake-word HEAD（也是 ios-remote-client HEAD）
   │
   ├── 4b90c99  fix(codex): reject inline MCP credentials…           ← feature/voice-focus 分叉点
   │      ├── 4a0f64b refactor(realtime): move cascaded response scheduling into the host
   │      └── e3fa448 fix(realtime): preserve response ownership through admission races   ← feature/voice-focus HEAD
   │
   └── fd16c5a … fad6b10 (16 commits: capability settings, knowledge ingestion / MCP / worker store)  ← v0.2.0dev HEAD
```

- `chinese-wake-word` 与 `v0.2.0dev` 的 merge-base 是 `9763e50`：它的工作树改动要跨过 dev 上 16 个 commit。
- `voice-focus` 与 `v0.2.0dev` 的 merge-base 是 `4b90c99`：跨 14 个 commit。
- 两条 feature 线之间**没有共同改动的已提交文件**；唯一交叉点是 `runtime/node-parity-audit.json`（wake-word 侧未提交、voice-focus 侧已提交）。

### 1.2 `feature/chinese-wake-word` 工作树（全部未提交）

```text
 M desktop/ambient-orb/{THIRD_PARTY_NOTICES.md, package.json, native/macos_voice_io.swift}
 M desktop/ambient-orb/scripts/{build-contract,inspect-package,release-dependency-closure}.mjs
 M desktop/ambient-orb/src/main/{main,native-audio,security,settings-apply,settings-store}.mjs
 M desktop/ambient-orb/src/preload/preload.cjs
 M desktop/ambient-orb/src/renderer/{capture-worklet,index,settings-controller,settings}.mjs, settings.html
 M desktop/ambient-orb/test/{builder-config,main-security,native-audio,security,settings-apply,settings-panel,settings-store}.test.mjs
 M package-lock.json  runtime/node-parity-audit.json
 M runtime/src/{desktop-bridge,desktop-service}.ts  runtime/test/desktop-bridge.test.ts
?? desktop/ambient-orb/scripts/wake-word-smoke.mjs
?? desktop/ambient-orb/src/main/wake-word/{model-manager,runtime,sherpa-detector,worker}.mjs
?? desktop/ambient-orb/src/renderer/wake-audio.mjs
?? desktop/ambient-orb/test/{wake-word,wake-word-model}.test.mjs
?? docs/specs/v0.2.0/10-local-wake-word.md
```

与 dev 在 `9763e50` 之后同时改动、合并时会冲突的文件：`main.mjs`（dev +124 / wake +57）、`settings-apply.mjs`、
`settings-store.mjs`、`settings-controller.mjs`、`settings.html`、`settings.mjs`、`preload.cjs`、`inspect-package.mjs`、
`desktop/ambient-orb/package.json`、三份 settings/main-security 测试、`package-lock.json`（dev +504 行 knowledge 依赖）、
`runtime/node-parity-audit.json`（dev +799 行）、`runtime/src/desktop-service.ts`。

### 1.3 `feature/voice-focus` 与 dev 的干跑合并

`git merge-tree --write-tree v0.2.0dev feature/voice-focus` → 树 `f981d3e`，2 处文本冲突、4 处自动合并：

| 文件 | 结果 | 说明 |
|---|---|---|
| `runtime/src/realtime/qwen.ts` | **冲突** | dev 在原地给 frontend-instructions 块加了 knowledge 两行；voice-focus 把整块搬去 `frontend-instructions.ts` |
| `desktop/ambient-orb/scripts/utility-runtime-smoke.mjs` | **冲突** | 双方各自把 `await app.whenReady()` 改成 `.then()`；dev 另加 `--capability-status` 模式 |
| `runtime/src/cascaded-realtime-assembly.ts` | 自动合并但**编译失败** ✔ | dev 侧调用 `frontendInstructions({ …, knowledge })`，voice-focus 侧的 `FrontendModuleSelection` 没有 `knowledge` 字段（TS2353） |
| `runtime/test/knowledge-assembly.test.ts` | 未触碰但**会失败** ✔ | `:15` 断言 `frontendInstructions({knowledge: true})` 含 `mcp__nova_knowledge__recall` |
| `runtime/node-parity-audit.json` | 自动合并 | 结构正确：219 files / 380 occurrences、无重复键、排序正确；`--check` 的数量校验仍需实跑 |
| `runtime/src/realtime-assembly.ts`、`runtime/package.json` | 自动合并 | 无语义冲突 |

### 1.4 主 checkout（v0.2.0dev）里的游离文件

| 路径 | 归属 | 核实结果 | 已拍板处置 |
|---|---|---|---|
| `docs/specs/v0.2.0/09-ios-remote-client.md` | `feature/ios-remote-client`（该 worktree 已暂存） | 与 ios worktree **逐字节相同** ✔ | 删除主 checkout 副本 |
| `docs/specs/v0.2.0/10-ios-aoq-evaluation.md` | 同上（ios worktree 未跟踪） | ios 版本多出第 10 节（+12 行），主 checkout 是**严格旧版** ✔ | 删除主 checkout 副本 |
| `docs/specs/v0.2.0/IOS-IMPLEMENTATION.md` | 同上（ios worktree 已暂存并再修改） | ios 版本多出实施记录（+60 行、3 处改写），主 checkout 是**严格旧版** ✔ | 删除主 checkout 副本 |
| `docs/design-notes/2026-09-05-voicemem-recall-integration-lessons.zh-CN.md` | voicemem 线 | `feature/voicemem-nova-integration` worktree 干净、无此文件 ✔ | 复制到该 worktree 并在该分支提交，再从主 checkout 删除 |
| `packages/voicemem-ts/` | voicemem 线（整包，含 node_modules/dist） | 未被任何已跟踪文件引用；不在 npm workspaces ✔ | 写入 `.git/info/exclude`（本机忽略、不提交；将来在 voicemem 分支提交该包时需先移除这一行或 `git add -f`） |

执行删除前须再次 `cmp` / `diff` 复核，确认 ios worktree 仍持有更新版本。

## 2. `feature/chinese-wake-word` 审查

### 2.1 功能概述

- **引擎**：`sherpa-onnx@1.13.4` 的纯 WebAssembly 构建（20 MB `.wasm`，无 `.node` 原生插件、无平台条件依赖），
  `createKws` 流式 zipformer 关键词检测；关键词 `你好星核` 由 Nova 写入 `keywords.txt`，不从归档读取。
- **模型分发**：不随包发布。首次启用时从 k2-fsa GitHub release 下载 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2`
  （约 40 MB），SHA-256 固定，白名单抽取（`basename` + `ARCHIVE_FILES`，无 zip-slip），校验 `tokens.txt` 后原子改名进
  `userData/models/wake-word/<name>`。
- **音频流**：麦克风（macOS 原生 `macos_voice_io` 或浏览器 AudioWorklet）→ renderer `WakeAudioRouter`（`wake-audio.mjs`）→
  `active` 态走既有 WebSocket 上传、`sleeping` 态走 `ipcRenderer.send('nova:wake-word:audio')` → main `WakeWordRuntime.accept`
  → `worker_threads` Worker → sherpa 检测。**检测在 main 的 worker 线程**，renderer 只路由字节。
- **状态机**：main 持有 `active | sleeping | blocked` 与单调递增 `epoch`；Swift helper 在渲染回调里快照 epoch 并随帧上报
  （`macos_voice_io.swift:280`），main 按帧校验 epoch。
- **与 runtime 的握手**：`desktop-bridge.ts` 新增 `onActivity(idle)`（可丢弃的 `desktop.activity` 帧）；`desktop-service.ts`
  以 1 Hz `setInterval` 从 `session.foregroundIdle && floor idle && 无 active delegate && executor idle` 推导 idle。
- **设置**：`wakeWordEnabled`（默认 `false`）、`autoHideSeconds`（默认 60，合法 `0 | 30..3600`）；新增 `backendSettings()` 剥掉这两个
  桌面专有字段，使仅改唤醒设置时**不重启后端**（这是对 spec 06「设置生效需事务 + 重启」规则的有意例外）。
- **依赖与声明**：`sherpa-onnx`（Apache-2.0）、`tar-stream`、`unbzip2-stream`（MIT）及 8 个传递包；`THIRD_PARTY_NOTICES.md` 与
  实际包内 LICENSE 一致。唯一弱点：`:17` 把改编来源指向被 gitignore 的 `thirdparty/qwen-audio-agent/...`，仓库内无法核验。

### 2.2 发现（按严重度）

| # | 级别 | 发现 | 位置 | 复核 |
|---|---|---|---|---|
| C1 | Critical | `WakeWordRuntime.stop()` 直接 `worker.terminate()`；下载在 worker 内进行，`prepare()` 的 `finally` 不会执行，`<name>-<pid>-<ts>.tar.bz2` 与 `.<name>-<pid>-<ts>/` 永久残留，反复开关无限累积，无任何清扫 | `wake-word/runtime.mjs:83-90`，`wake-word/model-manager.mjs:90-119` | ✔ |
| I2 | Important | native 采集在 helper 回 `capture.epoch` ack 之前**丢弃所有音频**，无超时、无重试、无诊断；epoch 在每次 mute/activated 变化时递增且**不受 `wakeWordEnabled` 约束**，即默认关闭的功能给默认开启的音频路径加了强制握手。帧本身已携带 `wakeEpoch`，`acknowledgedCaptureEpoch` 门控在逻辑上冗余 | `native-audio.mjs:131-132, 227-232`，`runtime.mjs:107-112` | ✔（门控与触发路径已确认；"stdin 积压"触发场景为推测） |
| I3 | Important | `hideOrb()` 在 `wakeWord.enabled` 时只调 `sleep()`，`sleep()` 在未激活 / 模型加载中返回 `false` 后**没有 `mainWindow.hide()` 兜底**；托盘点击与 `Cmd+Shift+Space` 静默失效 | `main.mjs:422-426`，`runtime.mjs:124-130` | ✔ |
| I4 | Important | `blocked` 态下 `hideOrb()` 反而 `wake()`，且每次 report 强制重新静音；用户既不能隐藏也不能取消静音，orb 内无任何指向设置面板的提示 | `main.mjs:423`，`runtime.mjs:103-106` | ✔ |
| I5 | Important | 心跳每秒 `session.snapshot()` 拷贝两个约 500 项的 id 集合与全部 delegate 记录，只为读一个 `length`；对所有桌面会话无条件执行 | `runtime/src/desktop-service.ts:167-176` | ✔ |
| I6 | Important | 心跳 `setInterval` 完全无测试：不测 idle 谓词组合、`unref`、abort 拆除，也不测回调内 `realtime.service.session` 抛错（未捕获会击穿后端进程）；`desktop-service.test.ts` 未改动 | 同上 | ✔ |
| I7 | Important | `detectLocalOnset(pcm)` 被移进 `upload` 回调，而 `upload` 受 `axes.connected` 门控；原生路径断连重连期间 orb 视觉"死掉"（原先无条件执行） | `renderer/index.mjs:565-570`，`wake-audio.mjs:18` | ◦ |
| I8 | Important | 是否重启后端用 `JSON.stringify(backendSettings(prev)) !== JSON.stringify(backendSettings(cur))` 判断；含 `secrets` 对象，若 codec 每次写入换 nonce 则优化永不生效（失败方向安全但无测试能发现） | `main.mjs:1016-1017` | ◦ |
| M | Minor | `lastReport` 未在构造器初始化（`NaN` 比较使 `accept` 门控 fail-open，当前不可达）；`runtime.mjs:147` 无 `?.`；worker 单帧异常即拆掉检测器并强制静音；`rmSync` 紧接 `renameSync`（Windows 见 4.6 B1）；KWS stream 从不释放；`keydown` 每键一次 IPC；活动信号只有 `pointerdown`/`keydown`；`droppedFrames` 无处可见；重启通知文案从"后台已重启并重新连接"退化为"设置已生效" | 各处 | ◦ |

**做得对的地方**：四个新入站 IPC 通道全部校验 `event.sender`（`main.mjs:993-1006`），出站 `nova:wake-word:changed` 只带
`{state,status,epoch}`；payload 有类型与 6400 字节 / 偶数长度上界；tar 抽取用 `basename` + 白名单；settings 无需升版本；
Swift 侧 epoch 快照位置正确且旧 helper 会被 `captureEpochSupported` 握手拒绝并回退到 `browser_aec`；模型缺文件或校验失败时
目录保持为空，`active` 态下载失败不影响会话；`security.mjs:54` 已设 `backgroundThrottling: false`（休眠后 renderer 不被节流）✔。

### 2.3 测试与打包

- `wake-word.test.mjs` 13 个实测：把 `index.mjs` 中真实的 ingress handler 源码抽出来在 `vm` 里对着真实 `WakeAudioRouter`
  跑（不是 mock 掉被测物）；worker 替换隔离、有界缓冲、心跳过期都有精确丢帧数断言。`native-audio.test.mjs:638-658` 走完整
  ack 状态机（I2 修复后需同步调整）。
- 缺口：Worker 被整体 mock，单测**从不加载 sherpa-onnx**；`extractSelected`（tar + bzip2）无任何测试、无 fixture 归档；
  `hideOrb()` 与托盘 / 快捷键重接线无测试；`main-security.test.mjs:695-696`、`settings-panel.test.mjs:804` 把精确形状正则放宽为
  `\{[\s\S]*?sendToOrb\(`，断言强度有小幅下降。
- 打包：20 MB `.wasm` 进 `app.asar`（未 `asarUnpack`，Emscripten 用 `fs.readFileSync` 读取，可行但每次 worker 启动读 20 MB）；
  三平台安装包各增约 20 MB；**Windows/Linux 上 `new Worker(new URL('./worker.mjs', import.meta.url))` 在 asar 内解析未验证**，
  这是最大的单一未测风险（详见 4.6）。`inspect-package.mjs` / `release-dependency-closure.mjs` 把依赖契约从"恰好等于 runtime"放宽为
  "每项都在 `DESKTOP_DEPENDENCIES` 内"，不再能发现**缺少** `sherpa-onnx`。
- `runtime/node-parity-audit.json`：6 条新 occurrence 的 hash 与位置与生成器行为一致，属"生成后按工具要求手写 disposition"；
  `process.pid` / `Date.now()` 用于临时文件名却只能标 `wire_json`，这是审计工具词汇表的缺口，不阻断。

### 2.4 spec 漂移

- 编号：`10-local-wake-word.md` 与 ios 线的 `10-ios-aoq-evaluation.md` 撞号。**已拍板：改为 `11-local-wake-word.md`**，
  并在 `00-overview.md` Volume 表、`IMPLEMENTATION.md` 补索引。
- 语言：`00-overview.md` Document conventions 要求英文正文 + 顶部中文摘要，01–08 均遵守；本 spec 为纯中文。**已拍板：重写为英文**。
- 内容：spec 的实现合同（epoch fence、6400/3200/100 ms 上界、preload 面、sender 校验、四个 sherpa 参数、模型名与 SHA、
  白名单抽取）与代码逐条对得上。需补写：I3/I4 的用户可见后果、`activationPending` 门控、修 I2 后"ack 前拒绝音频"的措辞。

### 2.5 已拍板的合并前处置

修 **C1 + I3 + I2 + I6**（均为小改动的 bug 修复，不加功能）；I5 / I7 / I8 / Minor 记入 spec 后续项。
I2 的处置方向：按帧 `wakeEpoch === captureEpoch` 即接受，去掉 `acknowledgedCaptureEpoch` 门控；保留 `capture.epoch` 事件
用于协议握手与诊断；同步调整 `native-audio.test.mjs` 与 spec 措辞。

## 3. `feature/voice-focus` 审查

### 3.1 变更概述

- `4a0f64b`：级联适配器不再自行调度——ASR final 只存入 `owner.userInput`，等宿主调 `ensureResponse(signal, userItemId)`；
  新增 provider 能力 `userResponseMode: 'automatic' | 'requested'`（Qwen automatic、级联 requested）；宿主
  `RealtimeSession` 增加 `#pendingUserResponse / #latestUserResponse / #userResponseRequest`，由 `RealtimeService.#deliveryPass`
  驱动。级联在接受生成命令时先分配自己的 response id 并**在 LLM 首包前**发 `response_started`，使响应可在首 token 前取消。
  frontend prompt 文本从 `qwen.ts` 搬到 provider 无关的 `frontend-instructions.ts`，`renderActiveProjectContext` /
  `renderActiveExecutorContext` / `HOST_ACTIVATION_PREFIX` 一并搬出（✔，这顺带修掉了 4.2 R-C 的两个 provider 泄漏）。
- `e3fa448`：宿主先登记 pending 记录再调 `provider.createResponse()`，失败时用新的 `discardPendingResponse` 回滚；
  `popPendingResponse()` 改为按 `origin.host_item_id` 的 `takePendingResponse()`，`user_item`/`unknown` 起始不消费任何记录；
  适配器不再在选输入时急切删除 `owner.pending`。
- 协议：`response_origin` 为严格判别联合 `{kind:'user_item', item_id} | {kind:'host_request', host_item_id} | {kind:'unknown'}`，
  注释与消费方（`approval.ts:954/1232/1377`，`service.ts:3015-3025/3184-3191/4124`）一致地把 origin 当**证据而非授权**，仍交叉核对
  item/revision。

### 3.2 与 dev 合并的语义断裂（Critical，全部已在 `f981d3e` 树上复核 ✔）

1. **移植 knowledge 模块**：在 `runtime/src/realtime/frontend-instructions.ts` 的 `FrontendModuleSelection` 加 `readonly knowledge?: boolean`，
   在 `frontendInstructions()` 数组末尾（`SEARCH_INSTRUCTIONS` 之后，保持 dev 顺序）加 dev `qwen.ts:251-252` 的两行
   `modules.knowledge === true ? [...] : []`。否则 `cascaded-realtime-assembly.ts:226` TS2353，`knowledge-assembly.test.ts:15` 失败，
   且级联管线会**静默丢失** knowledge MCP 路由。
2. **`qwen.ts` 冲突取 voice-focus 侧（删除）**：合并后的文件头 `:12-14` 已经 `import`/`export` 了 `frontend-instructions.js` 的同名符号，
   保留 dev 侧会重复声明。
3. **`utility-runtime-smoke.mjs:3` 与 `:7` 重复 import** `readFile, writeFile`——位于 git 自动合并区，无冲突标记，模块加载即 `SyntaxError`。
4. **`utility-runtime-smoke.mjs` 尾部 hunk 取 dev 侧**，不能"两边都留"（`let fixtureRoot, deadline` 与 `const deadline` 撞名）；
   dev 只在 `capabilityMode` 下设 45 s deadline，需给普通路径补回 voice-focus 的 30 s deadline 并统一走 `finish()`。

### 3.3 分支自身的发现

| # | 级别 | 发现 | 位置 | 复核 |
|---|---|---|---|---|
| I2 | Important | `responseMatchesUserItem` 在 `turn?.origin === undefined` 时返回 `true`，把"旧 provider 未给 origin"与"turn 记录已被 LRU 逐出"混为一谈，后者 fail-open；四个调用点都另有 revision 核对，故退化为分支前行为而非新洞 | `session.ts:196-203` | ◦ |
| I3 | Important | 被拒请求释放 `#fenceNextResponse` 时未检查是否本请求所 arm；当前 `armNextResponseFence` 只有测试调用、生产不可达，但注释里的推理不成立，下一个非 pending 的 arm 点会把它变成真 bug | `session.ts:683-685, 293-308` | ◦ |
| I4 | Important | `#userResponseRequest` 没有 terminal / provider_error 驱动的释放：provider admitted 后若在微任务窗口内 epoch 被撤销、`response_started` 未发出，`requestUserResponse` 永远返回 `false`，`providerIdle` 永远 `false`，直到重连 | `session.ts:664, 852, 1029`；`adapter.ts:834-841` | ◦ |
| I5 | Important（设计决策） | `host_request` 一律 `tools: []`：修好了"宿主播报冒出 tool_call_ready"的真实 live 失败，但 `host_request` 也覆盖 `tool_output` 续接，级联多步工具链在结构上不可能；仅由 oracle 测试 shim 间接固定 | `adapter.ts:889` | ◦ |
| I9 | Important | `e3fa448` 头条修复（pending 先于 `createResponse` 返回登记）唯一的测试依赖微任务交错、无显式屏障，可能静默变成 vacuous | `realtime-cascaded-provider-session.test.ts:536-574` | ◦ |
| M | Minor | 起始被 fence 拒绝时仍消费掉用户请求（按设计但无注释）；`#acceptTranscriptTerminal` 变 async 后转录处理可撤销 provider epoch（新耦合）；ASR 循环 `return` 改变会话寿命需注释；`active.id ??=` 死代码；parity audit 两条 `line: 829` 与实际 `:837` 不符（hash 正确、不影响 `--check`）；oracle fixture 用 `startsWith('Nova Audio Agent')` 猜测宿主播报 | 各处 | ◦ |
| — | 测试契约 | Volcengine oracle 测试为适配新契约做了四处"整形"（在 harness 里模拟宿主调度策略、双射改写 response id、剥掉 origin、把 `[]` 替换回旧工具表）；golden 不再能固定调度行为 | `realtime-volcengine-adapter-oracle.test.ts:437-448, 509-616` | ◦ |

测试覆盖整体扎实：协议判别联合严格性、三条 origin 安全测试（含"错误来源回复 → 真实用户转录 → confirm"旁路）、
`discardPendingResponse` 有确定性 RED 测试、abort-before-admission 上下文保留有参数化测试。

### 3.4 `docs/handoffs/` 五个新文件

无密钥、无主机名、无绝对路径。两份 `.md` 是高质量工程记录（含 `tools: []` 决策与未通过项的如实列举），应从
`docs/specs/v0.2.0/` 链接（现有唯一 handoff 有此惯例）。两份 `-report.json` 被 prose 引用，保留。
`2026-09-05-provider-contract-live-diagnostic.json` 是**失败运行**的孤儿诊断（`cancel_live_response: failed`），已被 prose 概括——**删除**。

### 3.5 已拍板的合并前处置

Critical 1–4 全部处理；I2 / I3 / I4 / I9 修复并带测试；删除孤儿诊断 json。**I5 保持现状**（有意设计，handoff 有记录），
补一个专门测试固定该行为并在文档写明"级联 `tool_output` 续接不提供工具"。

**2026-09-06 后续用户决定（取代上一段 I5 处置）**：仅宿主事实播报使用
`tools: []`；已绑定用户请求的 `tool_output` 续接保留配置工具，以支持多步工具链。
每次续接仍须核对原用户 item / revision 与宿主确认归属，`origin` 单独不构成授权。
上一段保留为审查时的历史方案，不能作为当前实施要求；当前契约及历史数字音频证据见
[provider-contract acceptance](2026-09-05-provider-contract-acceptance.md)。

## 4. `v0.2.0dev` 自身审查

### 4.1 门禁实测（本机 macOS，Node v24.8.0，2026-09-06 10:42）✔

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过。typecheck / lint / env-contract（generated blocks match）/ node-parity（218 files, 378 occurrences）/ executor-boundary（15 allowlisted）/ capabilities 漂移 |
| `npm run test:runtime` | 2306 项：2301 通过、0 失败、5 跳过（Windows-only），113 s |
| `npm run test:desktop` | 849 项：846 通过、0 失败、3 跳过（Windows Job guardian / MSVC bootstrap）；source startup smoke skipped |
| `npm run test:cli` | 21/21 |

这与 `IMPLEMENTATION.md:187-195` 记录的数字一致。注意：**全部是本机 macOS 结果**。`ci.yml` 只在 push `main`、tag `v*`、PR 时触发
（✔ `.github/workflows/ci.yml:3-7`），`origin/v0.2.0dev` 停在 `2cb2104`，所以 M1.5a/b/c、M2、M3、M4 共 91 个 commit **从未在
windows-latest / ubuntu-latest / macos-latest 上跑过**。本机跳过的 8 个 Windows-only 测试正是只有 Windows CI 才能执行的那些。

### 4.2 运行时核心（`runtime/src`）架构

**总评**：runtime spine 状态良好；provider 边界是真干净的——`session.ts` / `service.ts` / `approval.ts` 里 provider 名字只出现在注释
（◦）。`realtime/protocol.ts`（476 行）是本轮审查里设计最好的文件：zod 校验的 14 变体事件联合、可选能力方法、`workspaceContextDeliverySchema`
要求适配器"证明"它取代了哪个 prior item、`RealtimeProviderMediaCapability` 让原图注入在 provider 未声明时不可表达。第三个 provider 可以
在不碰 `session.ts` / `service.ts` 的前提下接入。

| # | 级别 | 发现 | 证据 | 复核 |
|---|---|---|---|---|
| R-A | Important（v0.2 加测试；v0.3 拆） | `RealtimeService` 是 god object：6540 行、94 字段、156 私有 / 67 公开方法；`handleEvent` 482 行。**项目确认 FSM** 79 方法 / 1520 行可整体抽出，且抽取模板就在旁边——`aeb78d1` 已把审批 FSM 抽成 `approval.ts:391 ApprovalHost`。但那次抽取只搬代码没收窄耦合（service 调 28 个 `#approvalHost.*`）。`service-state.ts` 名不副实（只有常量与接口，状态仍在 service 里）；`#lastProgressSummary` 与 `DelegateRecord.progress_summary` 双写（`service.ts:487, 2178, 2318, 2376`）。另有 **21 个 `*ForTest` 访问器**（`service.ts:6037-6180`）——测试伸手进私有状态，因为没有可观察的状态投影 | `service.ts` 各处 | ◦ |
| R-B | Important（发布前修） | 两个生产 assembly 是手抄：`qwen-realtime-assembly.ts:110-131` ≈ `cascaded-realtime-assembly.ts:271-292`（差 2 行）；`:155-193` ≈ `:309-345`（约 40 行 `...(options.X === undefined ? {} : {X})` 转发，差 3 行）；`:147-153` 与 `:301-307` 字节相同；`validateCodingResource` 两处相同。两文件在本分支 **13/13 个 commit 同时变更**。`integrated-realtime-assembly.ts:41,51` 的"注册表"是假的（`if (provider !== 'qwen') throw; registry.qwen(...)`），级联侧 ASR/TTS 用 `registry[selection.x]` 是对的，LLM 又是三元。修法：`realtime-assembly.ts` 里一个 `composeRealtime(core, provider, options, providerTuning)`，每管线只传 3 字段 tuning | 上述行号 | ◦ |
| R-C | Important | provider 合同的三个非字面量泄漏：(1) `realtime-assembly.ts:35` 从 `realtime/qwen.js` import `renderActive*Context`；(2) `qwen.ts:16` 从 `cascaded/llm.js` import `HOST_ACTIVATION_PREFIX`（integrated 依赖 cascaded 的模块）；(3) provider 能力协商发生在 `#startFresh`（`realtime-assembly.ts:327`）而非 build 期，缺少 `capabilities: {...}` 字段。**(1)(2) 由 voice-focus 合并顺带修掉** ✔（见 3.1）；(3) 留 v0.3 | `realtime-assembly.ts:35, 327, 656`；`qwen.ts:16, 55` | ✔/◦ |
| R-D | **Critical（发布前）** | **executor 边界未被证明，门禁是漏的。** spec 07 自己的验收标准（`07-executor-boundary.md:379` "Fixture executor (boundary proof)"，`:436` 复选框未勾）要求一个不 import Codex 的 fixture executor 跑通完整端口；`runtime/src/executors/` 下**没有** `fixture/`，`runtime/test/` 下**没有** `executor-boundary-fixture.test.ts` ✔。`check-executor-boundary.mjs:14` 的正则 `/['"]codex['"]\|codex__\|Codex[A-Z]/` 报"15 allowlisted"，而核心区大小写不敏感 `codex` 实际 **173 处** ✔，包括：**用户可听见的中文文案** `service-state.ts:68-69` `'Codex 当前正忙，本次操作未执行。'` ✔（spec 07 要求 `display_name` 替换）；**模型可见的 Surrogate prompt** `prompting.ts:98, 148-154` 用 Codex 词汇写注意力策略（golden 固定）；死代码 `FASTBRAIN_LIVE_SYSTEM`（`prompting.ts:42-89`）含已退役的 `codex.run/steer/status`，仅被 `prompting.test.ts` 引用 ✔；`codexResource` 命名遍布三个 assembly；`asProjectAdapter` 用 9 属性 duck-type + cast 恢复合同。此外 `ports.ts:118 executorRoleSchema = z.enum(['coding'])` + `coding-executor.ts:152-155`（>1 claimant 抛错）意味着 **Codex 与第二个 coding executor 只能替换、不能共存**（v0.3 设计项） | 上述 | ✔ |
| R-E | Important（便宜） | 桌面耦合：`DesktopOutputCallbacks` 9 个回调与 `RealtimeAssemblyOptions` 同名 9 个逐一手转发（一个 `onOutput(frame)` 判别联合即可收敛）；`desktop.ts:49-50` 重复声明 `desktop-wire.ts:27-28` 的 `MAX_DESKTOP_JSON_BYTES / MAX_DESKTOP_PCM_BYTES` ✔；**renderer 手写 wire 帧类型字面量**（`renderer/index.mjs:814, 817, 900, 923`、`confirmation-controls.mjs:93, 153`、`bubbles.mjs:9`，共 6 处；`desktop/ambient-orb/src` 中零处引用 `desktop-wire`）✔——改名一个帧类型两侧测试都绿、orb 静默失效。runtime 的 project store 依赖 Electron `process.resourcesPath` 定位原生 addon，包外打不开（fail-closed，但 `cli.ts` 无 project-store 路径） | 上述 | ✔ |
| R-F | Important（部分发布前） | 持久化：6 种落盘机制、5 个各自展开 `~/` 的路径解析（`capability-registry.ts:244`、`knowledge/assembly.ts:28`、`workspace-graph/factory.ts:41`、`realtime/telemetry.ts:142`、`executors/codex/host-config.ts:112`）；核心 state root 由 **Codex 所有的** env key `NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT` 命名。`project-store.ts:2520-2599 #saveState` 是模范实现（temp + fsync + `renameAt` + 目录 fsync + 身份复验 + fail-closed 原生锁）；但 `capabilities.json` 无原子写无锁（spec review P2-6 已接受却未实现）；维护 journal 回放不在 `ProjectStore.open()` 里（崩溃后 `state_busy` 直到桌面碰巧跑维护）。Memory 纯内存、不持久，glossary 不变量 3 是进程内顺序保证而非持久化——文档应说明 | 上述 | ◦ |
| R-G | Important（发布前加一项） | 测试：156 文件 / 80,742 行；`realtime-service.test.ts` **10,365 行**。session reducer 有 26 个 oracle fixture（好）；service 只有 11 个且全是 `compareQueuedHostResponses` 比较器场景——**delivery pass 作为状态机没有任何 fixture**。47 文件用计时器，170 处 `setImmediate` 作为"delivery pass 已静止"的屏障，另有 5 ms / 20 ms 真实 sleep（`:1239, 4922, 4954`）——编码了生产代码当前的 await 点数量。修法：`deliveryState(): DeliverySnapshot` + `(snapshot, event) → snapshot'` fixture 表，可退役大部分 `*ForTest` | 上述 | ◦ |
| R-H | Minor（建议收窄） | Python 遗产：`python-text.ts` 被 51 个文件引用，保留。parity audit 门禁已成摩擦：190 KB / 378 条，**本分支 20/92 个 commit 触碰该 json（+2607/−956）**，多为 `occurrence_index` 重编号；`numeric_template/numeric_string/number_format` 三类 142 条（38%）全部 disposition 为 `wire_json`（即"没问题"），而 wire 边界已由 `canonical-json.ts` 独立保证。建议：去掉这三类、不再固定 file inventory、以 `snippet_sha256` 而非序号为键；顺带删除 `FASTBRAIN_SYSTEM / FASTBRAIN_LIVE_SYSTEM` 及其 golden | `node-parity-audit.mjs:73-77, 135-137` | ◦ |

### 4.3 桌面端（`desktop/ambient-orb`）

| # | 级别 | 发现 | 证据 | 复核 |
|---|---|---|---|---|
| D-1 | **Critical（一行修）** | `before-quit` 先 `event.preventDefault()`，再 `Promise.all([backendDrain, maintenanceDrain])`；`backendDrain` 有界（8 s grace + 2 s force），**`maintenanceDrain = maintenance?.close()` 无超时无 catch**；后续 `before-quit` 全部在 `if (quitDrain) return` 处返回——一旦 `ManagedWorkspaceMaintenanceService.close()` 不结束，应用**只能 SIGKILL**（窗口已隐藏、只剩托盘）。修法：`Promise.race([maintenanceDrain, wait(3000)])`，`wait` 已存在于 `main.mjs:333` 且可注入 | `main.mjs:1384-1403` | ✔ |
| D-2 | Important | 设置事务无回滚：`settings-apply.mjs:66-78` 在 `prepareConfiguration/commitConfiguration` 失败与 `restartBackend` 失败时都返回 **`saved: true`**（`'failed'` / `'restart_failed'`），坏配置已落盘且下次启动重放；supervisor 对 `configuration_required / authentication_failed / unavailable` 取消重试（`backend-supervisor.mjs:78-82`）。无"上次可用设置"快照、无恢复入口。另：`settingsApplyStatus` 有两个写者（`main.mjs:303` 与 supervisor 回调 `:1241-1249`），同一事务可先报 `applied` 再报 `restart_failed` | ✔（settings-apply）/ ◦ | ✔/◦ |
| D-3 | Important（文档） | 安全姿态整体优秀：32 个 IPC 通道 **32/32 校验 `event.sender`**，CSP 无 `unsafe-inline/eval`，`contextIsolation/sandbox` 全开，preload 冻结且逐参数收敛。但**设置窗口实际上是受信任面**：`nova:capabilities:probe`（`main.mjs:1025`）→ `publicCapabilityProbe` → `mcp-client.ts` `StdioClientTransport` 会以用户配置的任意 `command/args/env` 起进程 ✔；`nova:settings:set` 会把 JSON 写到 renderer 提供的 `capabilitiesConfigPath`。这可能是有意的（MCP 配置本就是用户授权的代码执行），但 `SECURITY.md` 与代码注释都没写，与"renderer 不可信"的整体印象相反 | 上述 | ✔ |
| D-4 | Important | `main.mjs:1043` 注释"Plaintext values exist only in the inbound patch and the queued writer"不成立：`decryptSecretsForSpawn` 在 4 处从磁盘重新解密（`:254, 665, 1029, 1056`）。**实质属性成立**（明文从不回到 renderer，`publicSettings` 不含 `secrets`，回复只带 key 名），注释应改为描述方向而非生命周期 | `main.mjs` | ◦ |
| D-5 | Important（结构） | `main.mjs` 1405 行、26 个模块级可变全局；`startSelectedCamera`（`:768-1265`，约 498 行）拥有全部 32 个 IPC handler + supervisor 构造 + 托盘 + 全局快捷键，仅因闭包捕获 `launchId/camera/orbWindow/dragController` 而是一个函数。已抽出 27 个兄弟模块，抽取在这里停了。`openMemoryBoard` / `openSettingsWindow` 各自重写了 `configureWindowSecurity` 已做的 `setWindowOpenHandler + will-navigate`。修法：机械抽出 `installIpcHandlers({...})`，main 减半 | `main.mjs` | ◦ |
| D-6 | Important | 后端失败分类靠在 **1024 字节滑动窗口**里抓 `[runtime-diagnostic] <code>` 文本（`backend-diagnostics.mjs:26, 47`），45 个 code 手工维护、无测试断言其与 runtime 发射方一致；code 改名或其后 >1 KB 日志即静默降级为 `recoverable` → 无限 30 s 重连而非"配置错误"。就绪握手本身（token + loopback + 3 s/15 s 双超时 + `timingSafeEqual`）是桌面端最强的模块 | `backend.mjs:308-447`、`backend-diagnostics.mjs` | ◦ |
| D-7 | Minor | renderer：`axes` + `deriveOrbState`（`state.mjs:64-165` 纯函数、优先级梯子有注释）是真正的状态模型；但约 14 个 AudioContext/WebSocket 生命周期全局在模型之外，`processor !== null ⟺ audioMode === 'browser_aec'` 这类不变量无处表达；两条播放路径（browser / native）加一次中途回退，"现在什么在响、静音会停什么"要同时读 `index.mjs` 425-560 + 655-724、`audio.mjs` 449-635、`native-audio.mjs`，无图无文 | 上述 | ◦ |
| D-8 | Minor | 打包：51 个脚本，`inspect-package.mjs` 2317 行比 `main.mjs` 还大。核心闭环成立（`release-targets-v1.json` → `release-dependency-closure` → `inspect-package` → `installed-candidate-smoke`，两端 exit code 76/75/78 对齐并有测试）；周边是堆积：`build-contract.mjs` 手写 33 路径只做 `node --check`，漏掉 27 个 main 模块中的 17 个（含 `settings-apply`、`backend-supervisor`、`capabilities-settings`）；3 个脚本无人引用。**Linux 是声明的发布目标却零打包覆盖**（`ci.yml:44-52` package matrix 只有 macos + windows）。发布链是三个 `workflow_dispatch` 表单手抄 run id，默认版本已漂移（candidate `0.1.1` vs promote `0.1.0`），无 RELEASING 文档 | 上述 | ◦ |

### 4.4 知识库 M4（`runtime/src/knowledge`）

**架构**：文档只经宿主 `knowledge.ingest` 进入（绝对路径或 SSRF 防护的公网抓取），PDF/DOCX 在一次性的 128 MB parse Worker 里解析
（`pdfjs-dist` / `mammoth` + `jszip` 膨胀预检），按 3200/480 code point 分块，DashScope 兼容接口做 embedding，写入**独立 store Worker**
里的 `node:sqlite`（`sources/chunks/embeddings/jobs` + 探测到才建的 FTS5）。模型侧走进程内 MCP（`McpServer + Client + InMemoryTransport`，
与 `mcp-camera.ts` 同一房屋模式）暴露唯一工具 `mcp__nova_knowledge__recall`（暴力 cosine + 词法 RRF 融合）；另有**仓库里唯一的 MCP HTTP
loopback 监听**（仅 Codex 用，bearer token 每次启动随机、`timingSafeEqual`、Host/Origin 钉死、每请求新建 server）。命中只带
title/heading_path、路径被 `redactOutput` 打成 `[path]`，内部定位符 `knowledge://<source>/<chunk>?d=<12hex>` 只给宿主与 Codex 解析。
桌面以 `capabilities.json` `modules.knowledge.enabled`（默认 false）门控，导入只经 main 进程原生选择器。

**安全/隐私是本特性做得最好的部分**：`knowledge.sqlite` 以 `O_EXCL|O_NOFOLLOW` 创建 `0o600`，fd/path dev+ino 复验，`-wal/-shm` 显式
`chmod`，祖先目录经 realpath 往返防 symlink 替换；`runtime/src/knowledge/**` 零 `console`/日志调用；输出经 worker 侧 `redactOutput` 与 MCP
边界 `safeOutputText` 双重清洗；loopback token 不进 TOML（`knowledge-assembly.test.ts:57-60` 断言）。**每个 fix commit 都带测试**
（10/10 触碰 `knowledge-*.test.ts`）。

| # | 级别 | 发现 | 证据 | 复核 |
|---|---|---|---|---|
| K-1 | **Critical** | **`stale` 端到端断裂**：`store-worker.ts:301` 返回裸 `{status:'stale'}`，而 `mcp.ts:139` 要求 `stale` 必须带 `text/title/heading_path`（`exactKeys(value, ['status','text','title','heading_path'], ...)`），否则 `safeChunk` 返回 null → Codex 拿到 `unavailable`。唯一测 stale-over-MCP 的用例（`knowledge-mcp.test.ts:112-120`）用 mock backend 且 mock 返回了 text，恰好遮住了断裂。修法 3 行：把 `:296-299` 已取出的 row 字段随 `stale` 一起返回，并加一个**真实 store 穿过 `createKnowledgeMcpServer`** 的测试 | `store-worker.ts:294-304`，`mcp.ts:131-146` | ✔ |
| K-2 | **Critical（合同）** | spec `04:59-60, 157-169` 定义的 `content_digest` **不存在**：`locatorDigest = sha256(source_id:chunk_id).slice(0,12)`（`store-worker.ts:548-550`）是身份标签而非内容摘要 ✔。于是 spec 定义的 `stale`（"内容变了"）**不可达**——重建索引换 UUID 后旧定位符只会 `gone`，`stale` 现在只意味着"伪造的 digest"；`knowledge-store.test.ts:200` 靠手改 hex 才制造出 stale。要么加 `content_digest` 列并让 `d=` 派生自它，要么改 spec 声明 `d=` 是身份标签。**不能带着 spec 与代码对"引用保证了什么"意见相左发布** | 上述 | ✔ |
| K-3 | **Critical** | `KnowledgeStoreClient.close()` **无超时**（`store-client.ts:83-101`）✔；`assembly.ts:34` 与 `desktop-entry.ts:69` 都 `await` 它。worker 正在 `replaceSource` 两万块或卡在 `busy_timeout` 时 `#closing` 永不 settle → **应用退出挂死**（与 4.3 D-1 叠加）。`dead545` 之前的 250 ms 版本不会挂但会漏；正确版本是 race 一个约 2 s 的 timer 后 `terminate()` | `store-client.ts` | ✔ |
| K-4 | Important | FTS5 不可用时的降级**对用户不可见**：`open()` 不返回 `ftsAvailable`，`knowledge.status` 不带，面板不显示；词法腿从 `bm25()` 退化为 `LIKE %term%` 且按 `source_id, id` 排序（**无相关性排序**），Node 22 与 24 上同一语料检索质量不同而毫无信号。且 `enableFts` **每次 open 都全量重建 FTS 索引**（`store-worker.ts:159-168`，`DELETE + INSERT SELECT`），阻塞 `prepareKnowledge` → `desktop-entry.ts:67` 启动 | `store-worker.ts:133, 159-183, 524-546` | ◦ |
| K-5 | Important | 名为 "recall falls back to bounded lexical matching **without FTS5**" 的测试（`knowledge-store.test.ts:120`）✔ 并没有禁用 FTS5，只是换了 `provider_id` 让向量腿为空；本机 Node 24 有 FTS5，所以 `LIKE` 路径在现代 Node 上**从未被测到**。"55 项在 Node 22.13 通过"是唯一证据且 CI 不可复现。需要 `forceLexical` 之类的测试缝 | 上述 | ✔（测试名与内容） |
| K-6 | Important | recall **无可执行预算**：`store-client.ts:111-118` 不传 `AbortSignal`、无每请求超时；`service.ts:39` 的 8 s 与 manifest `deadline_budget: 7` 只取消调用方等待，worker 继续算。cosine 对同 provider **全部**向量做暴力扫描并逐行 `number[]` 分配（`store-worker.ts:262-269, 494-500`）：spec 自己的上限 2 万块 × 1024 维 ≈ 80 MB BLOB 读 + 2000 万浮点，不可取消，对着 7 s 语音 deadline，且规模下无测试 | 上述 | ◦ |
| K-7 | Important | 改 `embedding_model` 即改 `provider_id`（`embeddings.ts:62`），recall 按 `provider_id AND dims` 过滤（`store-worker.ts:265`）→ 语料**静默退化为纯词法**，无检测、无强制 reindex、只有 `settings.html:41` 一句静态提示；spec 承诺的 `reindex` job kind 不存在（`jobs` 表无此类型） | 上述 | ◦ |
| K-8 | Important | **没有任何测试让真实 store 穿过 MCP 层**：`knowledge-mcp.test.ts` 十个用例全部 mock backend，`knowledge-assembly.test.ts` 起了真 worker + 真 loopback 但从不 dispatch 一次 recall；唯一全栈路径是手动脚本 `knowledge-live-smoke.mjs`（不在 `npm test`，且 `:34-36` 吞掉错误码）。这正是 K-1 能活下来的原因 | 上述 | ◦ |
| K-9 | Minor（Windows） | `store-worker.ts:612, 615` 直接 `constants.O_NOFOLLOW`，Windows 上为 `undefined`，`x \| undefined === x` 静默丢掉 flag；`project-native-resource.ts:326` 用了正确的 `(O_NOFOLLOW ?? 0)` 写法 ✔。`lstatSync` 仍挡住常见情形，只剩窄 TOCTOU 窗口 | 上述 | ✔（代码）/ ◦（平台行为） |
| K-10 | Minor | `maxSources` 文档说可配置但不可（`assembly.ts:29` 不传；`store-worker.ts:435` 的 clamp 只能调低）；`knowledge.autoRecall` 出现在 spec 与 checklist 但代码里**不存在**；`safeHits` 全有或全无（一条命中触发 `rawSourcePath` 正则即整批 `unavailable`）；DOCX 解压两次且预检依赖 jszip 私有字段 `entry._data.uncompressedSize`（`parse-worker.ts:107`）；`MAX_CHUNKS / MAX_JOBS / PARSE_TIMEOUT_MS / MAX_REDIRECTS / 目录 100/1000 / loopback MAX_REQUESTS` 六个边界无 `+1` 测试；`knowledge-live-smoke.mjs:34-36` 丢弃错误 | 上述 | ◦ |

**04 验收清单在 `fad6b10` 里被整体勾成 `[x]`**，但 K-2（content_digest / stale 语义）与 `autoRecall` 两行言过其实。`00-overview.md:118-125`
自己说"批准实施，不等于验收前可发布"，`STATUS.zh-CN.md:23` 也是 🟡——三处里 checklist 是唯一说"全绿"的。

### 4.5 流程、CI 与文档一致性

| # | 级别 | 发现 | 证据 | 复核 |
|---|---|---|---|---|
| P-1 | **Critical** | **近三天 91 个 commit 零 CI 覆盖**（见 4.1）。丢失的不只是 Windows/Linux：也丢了干净 `npm ci` 的保证——所有验证都在一个有 32 个 worktree、`thirdparty/` 三个 checkout、`build/release-app/` 镜像的工作区里做的；`IMPLEMENTATION.md:255-257` 已经出现"沙箱内 EPERM/SIGABRT 是环境问题"这类只有没有中立 runner 才会有的判断。**Linux 是声明的发布目标（`release-targets-v1.json` 有 `linux-x64-gnu`），却从未被任何 workflow 打包过** | `ci.yml:3-7, 44-52` | ✔ |
| P-2 | Important（流程） | 提交节奏：42 fix / 20 feat / 16 docs。知识库序列 3 个 feat + 8 个 fix 在 22:24–23:33 之间从三个 worktree cherry-pick 进来（author ≠ committer 时间戳），`fee774e` 建 `parse-worker.ts` 后 **11 分钟** `4c00f20` 改同一文件；`9f1d812` 建 `store-worker.ts` 后 5 个 fix 只碰它。每个 fix 都带测试——这不是烂代码，是**review 记录泄进了历史**：feat 是草稿，fix 列车是 review。后果：`bisect`/`revert` 在特性粒度上不可用（`9f1d812` 单独是一个已知 shutdown 不 settle 的 worker）；worktree 里的增量历史被丢弃，只留下折叠的 feat+fix。同一模式在 camera（`f845181` → 8 个 fix）、registry（`dd00613` → `8a68858`）重复。修法便宜：cherry-pick 前 `rebase --autosquash` 把同会话的 harden/settle/bound 挤进其 feat | `git log` | ✔（时间戳）/ ◦（解读） |
| P-3 | Important（文档诚实性） | 三处矛盾：(a) **M1.5a `[x]`** 而其验收标准是"live rows identical to M1 validation"（`00-overview.md:107`），M1 的 live rows 自己承认未完成（`IMPLEMENTATION.md:521`）；`STATUS.zh-CN.md:18` 进一步写成"✅ 完成并经独立 review"、丢掉了 IMPLEMENTATION 保留的限定语。M1.5b 则正确地"不勾"——同一份文档知道该怎么做却没做一致。(b) M1 的各项 `[x]`（`IMPLEMENTATION.md:7-17`）与 `:19, :521` 说门槛未完成并存。(c) 提交 `f88989c` 标题 "**+ live acceptance**"，其 diff 修改的 ledger 写的是 "Not yet exercised … needs a voice session"（`IMPLEMENTATION.md:98-111`）。另：`IMPLEMENTATION.md:197` "M4 complete" 与 `:266` "M4 is not in scope" 因追加序而非状态序并存 | 上述 | ◦（引文行号来自静态审查） |
| P-4 | Important（决策缺位） | **v0.2.0 发布门槛未决定**：唯一提案是 `STATUS.zh-CN.md:223` 一个问号（"M1.5 全绿 + 真人语音链路 + 并发审批真机。M2/M3 不作为 v0.2 发布前置？"）✔。`release-publish.yml` 只校验版本号 / tag / npm 冲突，**不读任何里程碑状态**，每一行 live 都空着也能发布。`release-candidate.yml:163-171` 生成的"pending external-evidence ledger"是最接近的东西，但对着硬编码列表而非里程碑表 | 上述 | ✔ |
| P-5 | Minor（卫生） | 32 个 worktree、12 个 prunable、9 个已合并的 `thin-*` 仍在盘上，`voicemem-nova-integration` 与主 checkout 同在 `fad6b10`；两个 `memory-board-*.json`（55/75 KB，含 agent 记忆）在仓库根——导出对话框默认文件名落在 cwd，应改为 `app.getPath('downloads')`；`docs/specs/v0.2.0/03-capability-registry-and-mcp.md:286` 引用被 gitignore 的 `thirdparty/qwen-audio-agent/...` ✔；`build/release-app/` 是 60 文件的 `src/` 镜像，每次 grep 双倍命中；无 `CHANGELOG.md`；四个包锁定 `0.1.1`（有意，`00-overview.md:51-53`），但发布说明只能从 STATUS（仅中文）反推 | 上述 | ✔/◦ |

### 4.6 Windows 潜在问题

**先校正前提**：A 线（v0.2.0dev）比"整套 runtime 测试在 Windows 上跳过"给人的印象**硬得多**——`project-store.ts:2077-2095` 有原生 Windows ACL
路径，`:2581-2588` 有记录在案的目录 `FlushFileBuffers` 变通，`codex-discovery.mjs:62-70` 刻意避开 `.cmd` shim 改用 `node.exe + codex.js`，
`production-host.ts:606` 的 `detached` 按平台门控，fd-3 就绪管道早已换成 loopback TCP。2026-09-02 handoff 的未完项是**真机验收**，不是代码缺陷。
风险集中在 **B 线（唤醒词）**，它从未在 Windows 上跑过。

**(1) 确定 / 已经坏了**

| # | 发现 | 证据 | 后果 | 最便宜的验证 |
|---|---|---|---|---|
| A1 | Windows CI 跳过整套 runtime 测试，实际只因 **3 处**无平台门控的 POSIX mode 断言：`realtime-telemetry.test.ts:108, 149` 断言 `mode & 0o777 === 0o600`（Windows 报 `0o666`）✔；`codex-project-store.test.ts:3589, 4101` 断言 `chmod(0o755)` 后 `mode & 0o7777 === 0o755`（Windows 无操作）✔。handoff 也记了"3 fail … unchanged-main platform debt" | ✔ | 无用户可见后果，但**它是整套跳过的原因**，遮住了其他一切 | 不用验，改成收窄（见下） |
| B1 | `model-manager.mjs:113-114` `rmSync(directory, {recursive, force})` 紧接 `renameSync`，无 `maxRetries`（Node 默认 0，`force` 只吞 `ENOENT`）。Windows 上任何打开的句柄——上一个 worker 仍映射着 `.onnx`、Defender 正在扫刚解压的文件——都让 `rmSync` 抛 `EPERM`，`renameSync` 也无重试。POSIX 上两者无视打开描述符 | ✔（代码） | 模型重下载抛错 → `worker.mjs:20` 报 error → `fail()` → `status:'error'`，休眠中则 orb 以 `blocked` 强制弹出 | 加 `{maxRetries: 10, retryDelay: 100}` + rename 重试循环，比测还便宜 |
| B2 | 模型树的 `mode: 0o600/0o700`（`model-manager.mjs:66, 82, 92, 96, 108`）在 Windows 是静默无操作；`project-store.ts` 正因此走原生 `protectAt` ACL | ✔ | `%APPDATA%` 已按用户 ACL，单用户场景无实害 | 接受，或复用 `nova_project_native.node` ACL helper |

**(2) 很可能**

| # | 发现 | 后果 | 验证 |
|---|---|---|---|
| B3 | `new Worker(new URL('./worker.mjs', import.meta.url))`（`wake-word/runtime.mjs:48`）在打包后解析到 `file:///C:/…/resources/app.asar/src/main/wake-word/worker.mjs`。盘符本身没问题，但 **worker_threads 里的 ESM 从 asar 加载**是 Electron asar 补丁走得最少的角落（补丁覆盖公开 `fs`，ESM loader 走内部绑定）；Electron 43 对主入口 ESM asar 有支持，worker ESM 未同等验证。`runtime.mjs:71` 会把失败吞成 `fail()`，静默降级 | 源码树运行完全正常、**打包后唤醒词永远不工作** | `npm run package:win` → 安装 → 开唤醒 → 看 status 是否到 `ready`。源码运行**不会**复现 |
| B4 | 20 MB `.wasm` 从 asar 读：`electron-builder.yml` **没有任何 `asarUnpack`** ✔；emscripten loader 用 `__dirname + "/"` 拼路径后 `fs.readFileSync`（混合分隔符 Win32 可接受，Electron 有 asar 补丁），应能工作，但强制每次 worker 启动整读 20 MB 非 mmap（加 AV 扫描），且 `createSherpaWakeWordDetector` **无超时** | 冷启动多秒 `loading`；若失败则静默 `error` | 与 B3 同一打包 smoke；预防性加 `asarUnpack: '**/node_modules/sherpa-onnx/**'` |
| B6 | Windows 用户的 `codex` 是 `codex.cmd`，`desktop-startup.mjs:40-41` 明确拒绝 `.cmd/.bat/.ps1`（正确：`shell:false` 下 Node 拒绝 `.cmd`），自动发现靠 `codex.exe` 与 `node.exe + codex.js` 补偿；但**手动模式**（`codex-discovery.mjs:135-144`）用户粘贴 `where codex` 的 `%APPDATA%\npm\codex.cmd` 只得到一句 "not found" | Windows 首次配置的死胡同 | 文档：`getting-started.md:85-100` 讲了未签名候选包，没讲选哪个 Codex 二进制 |
| A2 | 见 4.4 K-9（knowledge store `O_NOFOLLOW` 静默丢失） | 窄 TOCTOU 窗口 | 静态：改成 `?? 0` 并注明平台差异 |

**(3) 推测**

- A3 `realpathSync(x) !== x` 精确字串比较（`production-host.ts:1060, 277`、`windows-guardian.ts:227, 234`、`store-worker.ts:601`）在大小写不敏感文件系统上：Windows `realpathSync` 返回盘上规范大小写并展开 8.3 短名，`resolve()` 保留调用方大小写。多数已被"发现时先 realpath 再存"化解（`desktop-startup.mjs:37`）；残余暴露是 `PATH` 里的 `C:\PROGRA~1\nodejs` 或手输的小写路径 → Codex 静默不可用。验证：Windows 上把 `codex_bin` 设成故意错大小写的绝对路径。
- A4 Codex 全部硬门控到 `win32-x64`（`project-native-resource.ts:321`、`windows-guardian.ts:222-224`；guardian 缺失时 `production-host.ts:201-208` 返回不可用 transport）。x64 构建在 WoW64 下 `process.arch === 'x64'`，所以 Windows-on-ARM 应能工作——只有显式 arm64 构建会静默禁用全部 Codex 功能。**买/借硬件前先知道这点**：Apple Silicon 上的 Parallels 跑 x64 NSIS 候选即可。
- 打包 `7zip-bin` 完整性检查（`inspect-package.mjs:1635-1644`）拒绝 symlink、mode/uid 检查已按 `win32` 门控；Windows `npm ci` 产生真文件，所以"需要真实 7zip-bin 文件"是 mac/linux 的顾虑。
- **C 线（voice-focus）确认干净**：`parseEnv` 对 CRLF 的 `\r` 会剥掉（实测），路径处理分隔符无关，`cascaded/adapter.ts` 无平台假设。
- **已排除**：静态审查曾提"隐藏 orb 后 renderer 被 `backgroundThrottling` 节流导致唤醒采集停摆"——唤醒词 worktree 的 `security.mjs:54` 已设 `backgroundThrottling: false` ✔，不是问题。

**收窄 Windows CI 跳过**：`runtime/package.json:39` 是平的 `node --test dist/test/*.test.js`，加一个 `test:runtime:win` 排除列表即可
（不要用 `--test-skip-pattern`，它匹配测试名不是文件名）。真正需要 POSIX 的只有 **6 / 153** 个文件：`realtime-telemetry`（或只门控那两行）、
`codex-project-store`（mode 往返）、`codex-process-owner`（进程组 / 描述符归属）、`codex-credential-snapshot`（uid/mode 合同）、
`codex-host-config`（`0o755`）、`knowledge-store`（`privateFile/ownedByCurrentUser`）。其余约 147 个在 windows-latest 上跑起来，就能第一次
真正执行 `workspace-graph/identity.ts:940`、`sensitivity.ts:201-214` 里刻意写的 `win32` 路径逻辑。另：`unsigned-packages.yml:38-46` 在 Windows
跳过 `test:desktop` 而 `ci.yml:34` 跑它，应统一。

**CI 收窄抓不到的**：(2) 里的每一项。B1/B3/B4 都依赖 asar、句柄或窗口可见性，需要一台真 Windows 上的 NSIS 安装包。**如果只有一台
Windows 虚拟机，最值钱的 10 分钟测试是**：安装候选包 → 开唤醒词 → 确认 `status:'ready'` → 让 orb 自动休眠 → 说唤醒词。这一条路径同时覆盖
B1、B3、B4。

### 4.7 `v0.2.0dev` 风险汇总

**发布前必修**（每项都有 ≤ 1 天的成比例修法，不需要重写）：

1. **P-1 / P-4**：把 `push: branches` 加上 `v0.2.0dev` 并推送，让 CI 覆盖 91 个 commit；把 `STATUS.zh-CN.md:223` 的问号变成 `00-overview.md` 里的决定，
   产出一份 `RELEASE-GATE.md`（每行 live 一个 `- [ ]`）并让 `release-publish.yml` 第一步 grep 未勾项即失败；修正 M1 / M1.5a 三处不一致的复选框。
   Linux 要么进 package matrix，要么从 `release-targets-v1.json` 与 closure 里删掉。
2. **R-D**：写 fixture executor（约 150 行 `ExecutorAdapter` + 脚本化 `ApprovalBroker` + `AgentDescriptor`）和那一个测试——它是唯一把"边界存在"从主张变成事实的东西；
   `service-state.ts:68-69` 改 `display_name`（两行）；删除 `prompting.ts:19-89` 死 prompt 及 golden；正则放宽到 `/codex/iu` 并一次性接受约 170 条 allowlist 作为诚实基线再往下压。
   **不要**在本版本动 `prompting.ts` 的 Surrogate prompt（golden 固定、涉及模型行为）。
3. **K-1 / K-2 / K-3**：`stale` 带回 text（3 行）+ 一个真实 store 穿 MCP 的测试；决定 `content_digest` 加列还是改 spec；`close()` 加 2 s race + `terminate()`。
   然后**如实重跑 04 清单**，不要预勾。
4. **D-1**：`before-quit` 的 `maintenanceDrain` race 3 s（一行）。
5. **D-2**：保留事务前的 `currentSettings` 快照，`restart_failed` 时面板给一个"恢复上次可用设置"；让 `publishStatus` 成为 `settingsApplyStatus` 唯一写者。
6. **R-B / R-E / R-F（便宜的部分）**：`composeRealtime` 帮助函数消掉两个 assembly 的 80 行手抄；`WIRE_FRAME_TYPES` 冻结数组 + 生成 `.mjs` 常量 + 一个两侧集合相等的测试，
   删掉 `desktop.ts:49-50` 重复常量；`capabilities.json` 复用 `#saveState` 的原子写；`ProjectStore.open()` 里调 `cleanupManagedMaintenanceJournal()`。
7. **R-G**：`deliveryState(): DeliverySnapshot` + `(snapshot, event) → snapshot'` fixture 表——这是任何 `service.ts` 拆分的前置证据。
8. **4.6 A1**：`test:runtime:win` 排除 6 个 POSIX 文件，其余在 windows-latest 上跑。

**v0.3 候选**（真正的设计变更，不要挤进 v0.2）：`ProjectConfirmationHost` 抽取并把两个 FSM 收敛到 `beforeEvent/afterEventAccepted` 两个钩子；
`executorRoleSchema` 多 claimant + `ProjectExecutorAdapter` 拆成 `CodingExecutor` 与可选 `ProjectBookkeeping`（Codex 与 Claude Code 共存的前提）；
`NOVA_AUDIO_AGENT_STATE_ROOT` 作为核心自有 key、五个 `~/` 解析器合一；parity audit 收窄（R-H）；两套 worker-thread SQLite RPC 合并；
provider `capabilities` 字段（R-C(3)）；K-6 recall 预算与分块 cosine；`installIpcHandlers` 抽取（D-5）。

## 5. 合入路线图

以下按顺序执行；每一步结束都要求 `git status` 干净、`npm run check` 与三套测试通过后再进入下一步。
合并方式已拍板为 **`git merge --no-ff`**，保留两条分支各自的 merge commit。第 4 节的 v0.2.0dev 自身修复放在两次合并**之后**（Phase 5），
因为两条 feature 线已经成型，先合再修可以避免它们再次 rebase；唯一例外是 Phase 0 的推送与 CI 触发，越早越好。

### Phase 0 — 现场清理（不改产品代码）

1. `.git/info/exclude` 追加 `packages/voicemem-ts/`。
2. 复制 design-note 到 `.worktrees/voicemem-nova-integration/docs/design-notes/`，在 `feature/voicemem-nova-integration` 提交
   `docs: record voicemem recall integration lessons`；从主 checkout 删除。
3. 再次 `cmp`/`diff` 三份 iOS 文档确认 ios worktree 持有更新版本后，从主 checkout 删除。
4. `ci.yml` 的 `push.branches` 加 `v0.2.0dev`（一行 workflow 改动，不算产品代码），`git push origin v0.2.0dev`，让 CI 三平台覆盖 91 个 commit；
   CI 结果作为后续合并的基线。
5. 本文自身作为 `docs(handoffs)` commit 进入 `v0.2.0dev`。

### Phase 1 — `feature/voice-focus`

1. 在 `.worktrees/voice-focus` 上追加 **1 个 commit**：`fix(realtime): close requested-mode ownership edges`
   —— I2（turn 缺失且 `requested` 模式时返回 `false`）、I3（`armedHere` 归属）、I4（先写复现"admitted 但从未 started"的
   失败测试，再补 terminal/provider_error 驱动的释放）、I9（给 provider-session 测试加显式屏障）、I5 专门测试、
   删除孤儿诊断 json、修正 parity audit 两条 `line` 字段。该 worktree 上跑 `npm run check` + `test:runtime`。
2. 主 checkout `git merge --no-ff feature/voice-focus`，按 3.2 的四条处方解决；`node runtime/scripts/node-parity-audit.mjs --check`。
3. 全量门禁 + 三套测试；`npm run smoke:node-backend --workspace @nova-audio-agent/ambient-orb` 验证 smoke 脚本可加载。

### Phase 2 — `feature/chinese-wake-word`

1. **先备份**：在该 worktree `git add -A && git commit -m "wip: local wake word snapshot (backup)"`，
   `git branch backup/chinese-wake-word-20260906`。
2. `git rebase v0.2.0dev`（把这一个快照 commit 挪到 Phase 1 之后的 dev 顶端），一次性解决 1.2 列出的冲突：
   `package-lock.json` 取 dev 侧后 `npm install` 重新引入 sherpa-onnx / tar-stream / unbzip2-stream；
   `node-parity-audit.json` 用 `--inventory` 重建两个数组，再挂回 wake-word 六条与 voice-focus 两条手写 disposition。
3. `git reset --soft v0.2.0dev && git reset`，重新整理为 **3 个 commit**：
   - `feat(runtime): publish desktop idle heartbeat for wake-word sleep` — `desktop-bridge.ts`、`desktop-service.ts`（含 I6 的 try/catch）、
     `desktop-bridge.test.ts`、新增 `desktop-service.test.ts` 心跳用例（abort 拆除、session 抛错不击穿进程）。
   - `feat(desktop): add local Chinese wake word (sherpa-onnx KWS)` — 全部 desktop 源码/测试/脚本/Swift、`package.json`、
     `package-lock.json`、`THIRD_PARTY_NOTICES.md`（改掉不可核验的来源路径）、`node-parity-audit.json`；内含 C1（`prepare()` 前
     清扫 `<name>-*.tar.bz2` 与 `.<name>-*` 孤儿）、I3（`sleep()` 返回 `false` 时 `mainWindow.hide()` 兜底）、I2（见 2.5）、
     以及 4.6 B1 的 `rmSync` 重试 + rename 重试（Windows 必需，macOS 无害）与 `electron-builder.yml` `asarUnpack` sherpa-onnx（B4 预防）。
   - `docs(specs): add 11-local-wake-word` — 英文重写、顶部中文摘要，只含 spec 文件本身。
4. 分支顶端跑全量门禁 + 三套测试 + `smoke:wake-word`（需本机已下载模型）。
5. 主 checkout `git merge --no-ff feature/chinese-wake-word`（rebase 后应无冲突）。

> 说明：feature 分支上原本没有 commit，"rebase"只是为新 commit 选父节点，不改写任何既有历史；`--no-ff` 仍保留分支拓扑。

### Phase 3 — 文档更新（1 个 commit：`docs: document local wake word and host-owned cascaded scheduling`）

| 文档 | 要改的位置 |
|---|---|
| `README.md` / `README.zh-CN.md` | §1 Highlights 加唤醒词一条；§3 Quickstart 平台说明补唤醒路径（原生 + 浏览器回退）；§5 Roadmap 加 `- [ ]` Windows/Linux 唤醒验收；级联条目注明调度已宿主化。两文件必须镜像（CONTRIBUTING 规则） |
| `docs/getting-started.md` / `.zh-CN.md` | 新增「本地唤醒词」节（默认关、首次启用下载模型、60 s 空闲默认、`0|30..3600`、静音语义、不重启后端即时生效）；`### Opt-in live smoke` 加级联 smoke（引用 workspace 级命令 `npm run smoke:cascaded --workspace @nova-audio-agent/runtime`，**不**新增 root 别名，**不**写"已通过"）；Windows 段补"手动模式请选 `codex.exe` 或 `node.exe + codex.js`，不是 `codex.cmd`"（4.6 B6）；不得触碰 GENERATED ENV CONTRACT 块 |
| `docs/architecture.md` | 模块表 `runtime/src/realtime/` 一行补 response admission/ownership 与 frontend-instructions；Platform notes 补 epoch 标记的原生采集；Realtime path 写明两种管线的调度都在宿主、`response_origin` 是证据不是授权；Security boundaries 加"休眠时麦克风数据只到桌面 Worker" |
| `docs/glossary.md` | 新词 Wake word、Auto-hide/sleep 状态、Frontend instructions、Response origin；与既有 `Wake reason` 显式区分 |
| `docs/specs/v0.2.0/00-overview.md` | Volume 表加 `11`；Review log 加本轮 |
| `docs/specs/v0.2.0/06-settings-and-config.md` | Settings v4 keys 表加两键并注明桌面专有、不进 `backendLaunchSpec`；Baseline 句补充；Non-goals 写明"唤醒开关/空闲时长即时生效"是有范围的例外；Panel IA 加行；Verification checklist 给两键 carve-out |
| `docs/specs/v0.2.0/IMPLEMENTATION.md` | 追加 2026-09-06 节：两次合并的内容、测试快照、链接两份 acceptance handoff、后续项清单（I5/I7/I8/Minor、Windows/Linux asar+WASM 验证、`extractSelected` fixture 测试、`DESKTOP_DEPENDENCIES` 集合相等）；同时修正 4.5 P-3 的三处复选框不一致 |
| `docs/specs/v0.2.0/STATUS.zh-CN.md` | 里程碑表加行；「五、还没做」补唤醒与级联 live 的未验项；「六、下一步」更新顺序；「八、相关文件」加 `session.ts`、`frontend-instructions.ts` |
| `docs/archs/09-roadmap.md` | 首段 foundation 句补唤醒词；与 README Roadmap 镜像 |
| `SECURITY.md` | 一段：设置窗口是受信任面，因为能力配置本身是用户授权的代码执行（4.3 D-3） |

**pinned 约束**（`runtime/test/documentation-contract.test.ts`）：不得出现 `desktop … audio remains … unwired`、`live … smoke … (landed|pass)`；
`getting-started.md` 必须保留 `M1.5c/live/Windows acceptance remains pending`、`Codex is app-server-only; JSONL is\s+fixture-parser-only`
两段（不可 reflow）；`next launch` / `下次启动` 措辞必须保留；管线箭头字面量 `Volcengine ASR -> Qwen \`qwen-flash\` -> Volcengine TTS`
不可插词。改完后：`npm run build --workspace @nova-audio-agent/runtime && node --test runtime/dist/test/documentation-contract.test.js`
与 `node runtime/scripts/check-env-contract.mjs --check`。

### Phase 4 — 收尾验证

`npm run check` → `npm run test:runtime` → `npm run test:desktop` → `npm run test:cli` → 四个 worktree `git status` 干净 →
`git log --graph --oneline -20` 显示两个 merge commit → `git push origin v0.2.0dev` → 等 CI 三平台结果。
独立复审（Codex / 子代理）按需在 Phase 1、2、3 各结束时进行；本轮用户已明确暂不引入 Codex。

### Phase 5 — `v0.2.0dev` 发布前修复（按 4.7 顺序，每项一个小 commit）

| # | commit | 内容 | 来源 |
|---|---|---|---|
| 5.1 | `ci: run on v0.2.0dev and narrow the Windows runtime skip` | `push.branches` 加分支（若 Phase 0 未做）；`test:runtime:win` 排除 6 个 POSIX 文件；`unsigned-packages.yml` 与 `ci.yml` 的 desktop 测试一致；Linux 进 package matrix 或从 targets 删除 | P-1、4.6 A1、D-8 |
| 5.2 | `fix(desktop): bound maintenance drain on quit` | `before-quit` 的 `maintenanceDrain` race 3 s | D-1 |
| 5.3 | `fix(knowledge): return stale chunks with text and bound store close` | K-1 三行 + 真实 store 穿 MCP 的测试；`close()` 2 s race + terminate；`O_NOFOLLOW ?? 0` | K-1、K-3、K-9 |
| 5.4 | `docs(specs): decide knowledge locator digest semantics` 或 `feat(knowledge): add content_digest`（二选一，见第 6 节） | K-2；同时如实重跑 04 清单、去掉 `autoRecall` 行或加设置 | K-2、K-10 |
| 5.5 | `test(runtime): prove the executor boundary with a fixture executor` | `executors/fixture/` + `executor-boundary-fixture.test.ts`；`service-state.ts:68-69` 改 `display_name`；删 `prompting.ts:19-89` 死 prompt 及 golden；正则放宽为 `/codex/iu` 并接受诚实基线 allowlist | R-D |
| 5.6 | `fix(desktop): keep a last-good settings snapshot for restart failures` | D-2 快照 + 面板恢复入口；`settingsApplyStatus` 单一写者；`main.mjs:1043` 注释改为描述方向 | D-2、D-4 |
| 5.7 | `refactor(runtime): share realtime composition between pipelines` | `composeRealtime` 帮助函数；integrated 注册表改为真查表 | R-B |
| 5.8 | `test(desktop): pin the wire frame-type set on both sides` | `WIRE_FRAME_TYPES` + 生成常量 + 集合相等测试；删 `desktop.ts:49-50` 重复常量 | R-E |
| 5.9 | `fix(runtime): atomic capabilities.json and journal replay on open` | 复用 `#saveState` 写法；`ProjectStore.open()` 调 `cleanupManagedMaintenanceJournal()` | R-F |
| 5.10 | `test(runtime): add delivery-pass state fixtures` | `deliveryState()` + fixture 表；退役可退役的 `*ForTest` | R-G |
| 5.11 | `docs: decide and enforce the v0.2.0 release gate` | `RELEASE-GATE.md` + `check:release-gate`；`release-publish.yml` 第一步接入；修正 P-3 三处复选框 | P-3、P-4 |
| 5.12 | `fix(knowledge): surface FTS availability and test the lexical fallback` | `open()` 返回 `fts`，`knowledge.status` 与面板显示；`forceLexical` 测试缝；FTS 索引按标记条件重建 | K-4、K-5 |

Windows 真机验收（4.6 的 10 分钟测试 + B6 文档核对）在 Phase 5 期间安排硬件，结果记入 `IMPLEMENTATION.md`；在拿到之前，任何文档不得声称唤醒词
或级联管线在 Windows 上通过。

### 提交计划一览

| 分支 | commit | 内容 |
|---|---|---|
| `v0.2.0dev` | `docs(handoffs): …` | 本文 |
| `v0.2.0dev` | `ci: trigger on v0.2.0dev pushes` | Phase 0 一行 |
| `feature/voicemem-nova-integration` | `docs: record voicemem recall integration lessons` | design-note 迁移 |
| `feature/voice-focus` | `fix(realtime): close requested-mode ownership edges` | I2/I3/I4/I9 + I5 测试 + 删 json |
| `v0.2.0dev` | merge `feature/voice-focus` (`--no-ff`) | 含 3.2 四条处方 |
| `feature/chinese-wake-word` | 3 个 commit（runtime 心跳 / desktop 唤醒词 / spec 11） | 含 C1/I2/I3/I6 + B1/B4 |
| `v0.2.0dev` | merge `feature/chinese-wake-word` (`--no-ff`) | 应无冲突 |
| `v0.2.0dev` | `docs: document local wake word and host-owned cascaded scheduling` | Phase 3 全部文档 |
| `v0.2.0dev` | Phase 5 的 12 个小 commit | 发布前修复 |

## 6. 未决与待拍板

1. **v0.2.0 发布门槛**：`STATUS.zh-CN.md:223` 的提案（M1.5 全绿 + 真人语音链路 + 并发审批真机；M2/M3 不作为前置）是否采纳？
   本文建议采纳，并把 M4 与唤醒词都列为"随版本发布但默认关闭、不进门槛"，Windows 唤醒词验收进门槛的"已知未验"栏而非阻断。
2. **知识库定位符语义（K-2）**：加 `content_digest` 列使 `stale` 真正可达，还是改 spec 声明 `d=` 只是身份标签？建议前者（它是 spec 最初的设计意图，
   也是 Codex 依赖"引用是否仍指向同一内容"的唯一依据），工作量约半天。
3. **spec 11 的英文重写**是否保留顶部中文摘要（conventions 要求有；本轮口头决定为"全英文"）。
4. **I5**（级联 `host_request` 一律 `tools: []`）是否需要在 v0.2.0 内收窄到仅宿主事实播报，让 `tool_output` 续接保留工具。
5. **Linux**：进 CI package matrix，还是从发布目标里删掉直到有人验收？
6. **cherry-pick 前 autosquash** 作为团队约定写进 `CONTRIBUTING.md`？

## 附录 A — 门禁与测试命令

```bash
npm run check          # typecheck + lint + env-contract + node-parity + executor-boundary + capabilities 漂移
npm run test:runtime   # build + node --test dist/test/*.test.js（153 个文件）
npm run test:desktop   # build + node --test + source-startup-smoke（72 个文件）
npm run test:cli
node runtime/scripts/node-parity-audit.mjs --check      # 合并后必跑
node runtime/scripts/node-parity-audit.mjs --inventory  # 只打印机器可见字段；--write 被有意禁用
```

macOS 上没有 GNU `timeout`；给长测试加界限用 `perl -e 'alarm shift; exec @ARGV' 1800 npm run test:runtime`。

## 附录 B — `node-parity-audit.json` 手工维护法

`--check` 逐项比较 `files`（有序、按 canonical path 排序）、`occurrences.length`、以及每条的 `file/kind/occurrence_index/snippet_sha256`；
`disposition/behavior/test` 三个字段只能手写，`behavior` 必须逐字出现在 `test` 指向的测试文件里。新增源文件时：`--inventory` 取新数组，
按排序位插入 `files`，按位置插入 occurrence 并补三个手写字段。合并两条分支时不要拼接 hunk，直接用 `--inventory` 重建后挂回手写字段。
`--inventory` 输出 `schema_version: 1`，`--check` 要求 `2`，不能直接覆盖文件。

## 附录 C — 本轮审查方法与局限

- 六路只读静态审查（Explore 子代理，opus），每路给定精确范围与必读的项目自有设计文档；结论中标 ✔ 的项由主线程在源码或 `merge-tree` 干跑树上逐条复核，
  标 ◦ 的项行号来自子代理引用，未逐条复核但与复核过的邻近事实一致。
- 未运行任何合并、rebase、checkout；未修改任何产品代码；门禁与测试只在主 checkout（`fad6b10`）上跑过一次。
- 静态审查有一处已确认的误报（`backgroundThrottling`，见 4.6"已排除"），提醒读者 ◦ 项须在动手前再看一眼源码。
- 未做：真人语音、Windows/Linux 真机、级联 live smoke、唤醒词 live smoke。所有"很可能 / 推测"级的 Windows 项都需要真机才能关闭。
