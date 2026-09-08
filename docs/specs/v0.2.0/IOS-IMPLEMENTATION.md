# iOS Remote Client Implementation Plan

> **For agentic workers:** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 按工作包实施；先读取设计提案。用户已批准实施；当前进度与实测证据见下方实施记录。

**Goal:** 在同一 repo 内并行开发原生 iOS 语音客户端与可通过 Tailscale 连接的 Nova 常驻服务。

**Architecture:** iOS 管设备音频和 UI，家里 Node Runtime 管对话、授权和 Codex。共享最小客户端协议，复用现有业务与媒体语义；客户端断线不等同于任务取消。

**Tech Stack:** 现有 Node/TypeScript/ws/zod；SwiftUI、AVAudioEngine、URLSessionWebSocketTask、Keychain；Tailscale Serve。

**Spec:** [09-ios-remote-client.md](09-ios-remote-client.md)

## Global Constraints

- 基线 `v0.2.0dev` / `9763e5045a4f15f6c37ba7e177c133a5438d58d9`；后续实施前重新核对 HEAD 与工作区。
- Node + TypeScript 是权威 Runtime；Swift 不复制任务编排和授权逻辑。
- 首版单用户、单活跃语音连接，iOS 工程基线建议 17+，首个服务部署目标 macOS。
- 不改变旧桌面 wire 行为，不把 iOS 加入 npm workspaces，不扩大 v0.2.0 原发布门槛。
- 不自动重试副作用，不把网络中断当成 Codex 取消，不承诺进程重启后执行恢复。
- 本轮发现已有未跟踪文件 `runtime/test/codex-managed-mcp.test.ts`，不纳入本规划提交；实际执行时继续保护当时用户变更。

## 工作包与依赖

```text
P0 协议、向量、模拟服务
 ├─ P1 常驻服务 → P2 断线与任务隔离 ─┐
 └─ P3 iOS 协议/UI → P4 原生音频 ───┼─ P5 真机端到端
                                   └─ P6 桌面共享服务（后续）
```

P0 到 P5 为首版；P6 可独立延期。以下文件路径是规划实施落点；实际新增文件见实施记录。实现细节以验证后的最小差异为准，不为目录结构创建空壳。

## P0：冻结最小远程契约与联调输入

**责任范围：** `docs/protocols/client-v1.md`、`fixtures/client-protocol/v1/`、`runtime/test/client-protocol.test.ts`、`runtime/scripts/client-protocol-mock.mjs`。
**输入：** 现有 `desktop-wire.ts`、`desktop.ts`、`desktop-progress.ts` 与对应测试。
**输出：** 设计第 4 节的握手、命令回执和现有 payload 的精确字节向量；后端与 Swift 共用。

- [ ] 列出首版所有消息及限制，核对真实 provider 输入/输出采样率，固定 v1 ready 格式。
- [ ] 用现有编码器输出有效媒体向量；补短帧、超长头、奇数 PCM、Unicode 字幕、旧 generation、无效审批和版本不匹配案例。
- [ ] 新增 Node 检查：有效向量往返一致，非法向量明确拒绝；先运行确认能抓住被故意破坏的帧，再恢复正确向量运行。
- [ ] 写模拟 WSS 前的本地 WS 服务，按固定顺序发 ready、字幕、音频、clear、审批、结果，并支持主动断线和 busy。仅用于开发，不连接模型或执行命令。
- [ ] 文档提供模拟服务启动与各场景选择命令；协议提交经两条实现线共同接受后冻结。

**通过条件：** 两边不用阅读对方业务实现即可解释同一 fixture；模拟脚本不需要生产密钥。

## P1：常驻服务入口与认证

**修改：** `runtime/src/desktop-entry.ts`、`desktop-service.ts`、`desktop.ts`、`environment-contract.ts`、`runtime/package.json`。
**新增：** `runtime/src/server-entry.ts`、`runtime/src/server-config.ts`、`runtime/src/production-composition.ts`、`runtime/test/server-entry.test.ts`、`docs/deployment/remote-server.md`。
**输入：** P0 remote v1；现有 `buildProductionRealtimeAssembly` 与 Codex/MCP resource ownership。
**输出：** localhost 固定端口的独立 Node 服务、凭据初始化/轮换入口、无密钥 ready 日志；桌面入口继续可用。

- [ ] 先增加启动测试：没有 Electron 父进程也能启动；缺失凭据、非法端口在创建模型/Codex 资源前失败。
- [ ] 只提取两入口共用的组装代码，保留资源登记与失败逆序清理；服务路径关闭相机模块。
- [ ] 实现 `/client/v1` 认证和 ready；未认证音频、未知版本、超时、第二连接都拒绝。旧 `/` 保持原桌面行为。
- [ ] 用系统随机源生成凭据，限制本机凭据文件权限；轮换时撤销现有连接。测试旧凭据无法重新认证，日志不包含凭据。
- [ ] 新配置项登记 env contract；配置缺失不从 Electron Settings 或当前 shell 工作目录猜测项目与凭据。
- [ ] 部署文档给出构建、环境配置、服务启动、launchd、Tailscale Serve、停止与诊断步骤；端口占用失败，不能偷偷换随机端口。

**通过条件：** 独立启动与正常停止通过；TS 测试客户端经私网完成认证并收到 ready；原桌面启动回归通过。

## P2：网络故障与工作生命周期隔离

**修改：** `runtime/src/desktop-bridge.ts`、`desktop-realtime.ts`，必要时 `desktop-service.ts`、`realtime/service.ts`、`realtime-assembly.ts`。
**新增/扩展测试：** `runtime/test/remote-session.test.ts` 与现有 desktop bridge/service 测试。
**输入：** P1 的 server instance/connection identity、P0 命令格式。
**输出：** 有界请求去重、命令回执、重连快照；只作用于当前连接的传输失败。

- [ ] 用受控执行器启动工作，主动断开连接，断言没有 cancel/close 调用且新连接收到同一个 work_id。
- [ ] 注入发送失败和队列溢出，断言旧媒体清空、服务仍监听、授权工作未被终止；区分可恢复连接错误与真正服务致命错误。
- [ ] 覆盖旧连接晚回调、新连接到达、过期审批重放、相同 request_id 不同 payload、超过 256 条请求、跨连接重试被拒绝。
- [ ] 对 clear 后到达的旧音频和重复播放完成回执，验证原有 generation fence 仍有效。
- [ ] 在 provider 故障用例中确定当前 task owner 清理范围；若会影响 Codex，明确 UI/文档限制，不把媒体隔离测试当成 provider 恢复证明。

**通过条件：** 网络故障矩阵通过，项目确认与 Codex 审批语义未放宽。

## P3：Swift 客户端连接、协议与界面

**新增：** `ios/Nova/Nova.xcodeproj/`、`ios/Nova/Nova/{NovaApp.swift,Connection/,Protocol/,Views/}`、`ios/Nova/NovaTests/`、`ios/Nova/README.md`、`.github/workflows/ios.yml`。
**输入：** P0 fixtures/mock；不依赖 P1 完成。
**输出：** shared scheme `Nova` 的可构建 App，可显示模拟字幕/结果/审批并提交控制。

- [ ] 检查本机 Xcode、可用 simulator SDK 与目标 iPhone；创建 SwiftUI 工程、shared scheme 和测试 target，签名账户不写入共享配置。
- [ ] Swift 读取同一组 fixtures，先验证有效解析与非法长度拒绝；用 UInt/Int 精确转换约束服务端整数范围，避免溢出。
- [ ] 实现 Keychain 凭据、WSS 连接、ready 校验、有限退避重连；断开即清除可操作的旧审批状态，重连等待权威快照。
- [ ] 做连接页/通话页/结果和审批卡片；busy、unauthorized、disconnected、server restarted 有明确状态。
- [ ] 先接 mock 验证完整状态序列；审批按钮等待宿主状态而非点击即宣称成功。
- [ ] iOS CI 只跑相关路径与共享 fixtures 变化；构建无签名 simulator 目标并运行 NovaTests，不在 Linux npm job 中调用 Xcode。

**通过条件：** simulator 构建和协议测试通过；模拟服务完成一次审批/结果闭环。

## P4：原生双向音频与打断

**新增：** `ios/Nova/Nova/Audio/`；修改通话 UI 与协议接收路径，扩展 `NovaTests`。
**输入：** P3 连接生命周期、ready 音频格式、NOVA 帧头和播放控制。
**输出：** 采集/重采样/播放/打断及真实播放回执。

- [ ] 为纯播放代次逻辑增加检查：clear 后旧帧不播，新代次可播，断线使旧回调失效。
- [ ] 配置 AVAudioSession 与 AVAudioEngine Voice Processing；拒绝麦克风权限时停止启动流程并提供设置提示。
- [ ] 上行重采样为声明格式、下行有界播放队列；按实际渲染状态回报 played_ms，不按网络接收量推算。
- [ ] 检测本地 speech onset 后立即停播并走现有控制路径；静音和结束通话停止采集。
- [ ] 真机覆盖扬声器、耳机切换、来电中断和重新开始；先通过前台，再单独加入后台 audio entitlement/config 并验锁屏。

**通过条件：** 前台真机可边听边说并打断，无明显自回声；锁屏未通过时保持功能明确受限。

## P5：合流与真实 Codex 验收

**新增：** `docs/acceptance/ios-remote-client.md`，按发现修改对应最小代码范围。
**输入：** P2 服务端与 P4 手机端。
**输出：** 可重复部署说明和真机证据，按项区分通过/失败/未测。

- [ ] 从无 Electron 的服务启动开始，手机经 Tailscale 发起真实语音任务，完成项目确认、权限审批、Codex 执行、结果回报。
- [ ] 执行中断网和审批中断网各验证一次；确认同 work_id 不重复执行、失效审批不生效、重连不播旧声音。
- [ ] 测家庭 Wi-Fi、蜂窝和可取得的 relay 路径；记录设备/系统、网络类型、direct/relay、延迟与积压。无法取得 relay 时标未测。
- [ ] 记录本地停播 p95 与连接可达后的状态恢复 p95；初始目标分别 ≤150 ms、≤5 s，不把模型首音延迟混入本地停播。
- [ ] 串行运行仓库校验、Runtime、桌面、CLI 检查及 iOS tests；每类失败区分环境与产品原因。

现有仓库完整回归命令（串行执行，Runtime/桌面构建都会写 `runtime/dist`）：

```sh
npm run check
npm run test:runtime
npm run test:desktop
npm run test:cli
```

新增测试编译后用现有 Node runner 运行，例如：

```sh
npm run build --workspace @nova-audio-agent/runtime
node --test runtime/dist/test/client-protocol.test.js runtime/dist/test/server-entry.test.js runtime/dist/test/remote-session.test.js
```

iOS 在工程落地后使用 shared scheme `Nova` 执行 `xcodebuild test`，destination 从 `xcodebuild -showdestinations` 返回的可用 simulator 中选择；README 和 CI 使用实际验证的 Xcode/SDK 组合，不预填不存在的 simulator UUID。

## P6：桌面共享常驻服务（首版之后）

修改桌面 `backend.mjs`、supervisor、Settings 与连接 UI，增加显式 remote mode；remote mode 不启动或停止家里的服务进程。沿用单活跃客户端，先实现手动断开/重连，再考虑可见的接管机制。验收关闭桌面窗口不会结束远程 Codex 工作。

## 风险与排期方法

最大不确定性是 task owner 与 realtime provider 生命周期，以及真机 AEC/蓝牙表现；P2 和 P4 应尽早完成风险验证。P0 冻结后两线并行，避免先做大量 UI 再发现协议要换。先按六个可验收工作包安排，不把未经原型验证的工期当承诺；P2/P4 得到数据后再估剩余日历时间。

## 本规划完成检查

- [x] 基线和现有入口/transport/resource 所有权已核对。
- [x] 首版范围、后续范围、文件归属、并行依赖和验收条件已写明。
- [x] 区分现有行为、拟定接口和未验证能力。
- [x] 已进入实施；完整真机验收仍待完成。


## 实施记录（2026-09-05）

实现位于 `feature/ios-remote-client`，隔离目录 `.worktrees/ios-remote-client`，不混入主工作区并行修改。

- P0–P4 核心代码已落地：独立 `/client/v1` transport、共享 production composition、断线任务隔离，以及 `ios/Nova` 原生客户端。现有桌面 transport 保留。
- 共享 10 个音频字节向量由 Swift 和 TypeScript 验证；模拟服务覆盖项目确认、字幕、音频、clear、busy 和主动断线。完整 Codex 审批/结果端到端场景仍属于 P5。
- 凭据轮换使用文档中的停止服务、替换本地凭据、重新启动流程；首版没有在线轮换 API。
- iOS 工程使用系统 SwiftUI、AVAudioEngine、URLSessionWebSocketTask 与 Keychain，无第三方音频依赖。已完成签名设备构建；仓库不保存开发团队或 provisioning 信息。
- 真实 Qwen 本机联调通过：合成输入“你好，请用一句话介绍一下你自己。”被正确识别，收到完整回答字幕、17 个音频帧（含协议头共 312220 字节）及播放终止事件。测试没有采集用户麦克风，也没有运行 Codex 工作；不能替代真机听感验收。
- Tailscale 1.102.3 已安装，系统扩展和 VPN 权限获准。初次安装的 IPC 卡死在 Mac 重启后恢复；CLI 已能返回 Logged out，Safari 已打开登录页。等待用户登录后配置 Serve，尚无 tailnet WSS 地址。此前系统级 VPN 管理器重启被自动审批拒绝，该操作未由本任务执行。
- `fishwowater的iPhone` 在 Mac 重启后恢复可达，Nova 已安装成功。初次启动需信任开发者；本机签名检查通过，profile 包含该 UDID 且有效。用户已确认“Nova 已打开”，真机安装/启动通过。扬声器/AirPods、静音恢复、打断延迟、蜂窝/direct/relay、真实 Codex 授权执行均未验收。

详细构建、操作和限制见 [iOS README](../../../ios/Nova/README.md)、[部署说明](../../deployment/remote-server.md) 和 [协议](../../protocols/client-v1.md)。上述工作包复选框保留为完整验收门槛，代码已实现不等于全部门槛通过。

### 自动化验证快照

- `npm run check` 通过（TypeScript、lint、环境契约、Node parity、executor boundary、capability drift）。
- 完整 Runtime（最终重跑）：2267 项，2259 通过、5 跳过、3 失败。3 项分别为 `codex-contract` 包根导出、`executors-camera` manifest 期望、`executors-codex` 包根导出回退；在 `9763e50` 独立编译运行同样 35 项得到同样 3 失败，相关源文件一致，未扩大本次修复范围。
- 桌面：814 项，811 通过、3 跳过；打包工具完整性检查需要工作目录中的真实 `7zip-bin` 文件，跨目录符号链接不满足其既有校验。Windows source startup smoke 在 macOS 按设计跳过。
- CLI：21/21 通过。
- Swift 纯协议/播放检查：9/9 通过；iOS SDK 签名构建通过。Simulator SDK 可编译 NovaTests，但本机未安装 simulator runtime，因此尚未实际运行 iOS-only XCTest。

- 关键检查点使用外部 Claude CLI `claude-fable-5-1[1m]` 静态审查（用户明确授权发送代码）。发现并修复：一次模型重置失败不能永久封死语音恢复；握手后的 Swift 帧解析错误不能误报为不可重试的版本错误。Sol 的协议小检查点另发现无控制消费者时不能返回虚假 applied，已修复并测试。
- 最新针对性回归 90/90 通过，涵盖真实端点检测的 A/B 语音隔离、迟到 ASR/PCM、失败后恢复、断线任务存活、控制回执和桌面桥接。

- 外部 Claude 定向复审确认两项发现已解决；报告对未重复提供的 reconnect helper 保留静态范围限制，相关失败恢复测试已实际通过。Sol 定向复审通过控制消费者修复。
- Mac 重启清除了 `/private/tmp` 的临时构建和日志。重启后在忽略目录 `build/ios-checkpoint` 重新完成签名构建和完整 Runtime 回归；安装包为 `products/Debug-iphoneos/Nova.app`。
- 本机已启动 `127.0.0.1:19876` 语音联调服务；私有配置在 `~/.nova-remote/voice-check.env`，凭据保存在同目录的 `client-token`（0600）。此联调配置关闭执行器，只验证语音；真实 Codex 工作仍待 P5 配置与验收。

### iOS 视觉检查点（2026-09-05）

- 主界面更新为深墨色与薄荷色、语音球、对话卡片和底部通话控制；连接配置移至设置 sheet。保留真实连接/授权状态，无演示字幕。
- 图像生成工具生成图标，1024px 不透明源图和五种设备尺寸已入工程；工具未提供模型选择参数，因此不标称指定模型已验证。
- Terra 定向复审通过：VoiceOver 状态播报、重试耗尽后的手动重连提示、审批结果中文文案，以及 PNG 图标声明/资源配置。
- 签名 iPhone SDK 构建通过，现有 Swift 检查 9/9 通过，更新安装到用户 iPhone 成功。自动启动被设备锁屏拒绝，等待解锁后核对实际显示；尚不声明视觉真机验收或语音链路验收完成。
- Tailscale CLI 本次复查仍为 Logged out，私网 Serve 与手机语音联调继续等待账户登录。
- 用户随后解锁并打开新版 Nova，确认“效果没问题”，真机视觉显示验收通过。
- Safari 已显示 FishWoWater / fishwowater.github 的设备接入页，但点击 Connect device to tailnet 后要求重新认证；Mac CLI 仍为 NeedsLogin。点击 GitHub 登录被自动审批拒绝，未执行 OAuth 登录，等待用户完成重新认证与设备接入。Nova 127.0.0.1:19876 监听正常，Serve 当前无配置。
- 用户明确授权 tailnet HTTPS 证书后，Serve 已启用：`https://kantjjwang-mc1.tail322165.ts.net` → `http://127.0.0.1:19876`，仅 tailnet 可达，未启用 Funnel。Mac IP 为 `100.125.147.24`。
- 经该域名执行真实 WSS `/client/v1` 握手通过：TLS authorized=true，返回 `client.ready` / protocol_version=1，随后正常关闭 1000。只做连接测试，不采集麦克风，不执行 Codex。手机 Tailscale 登录/连接状态仍待用户确认，不能等同跨设备语音验收。

### 真机采集恢复与界面迭代（2026-09-05 晚）

- 真机原故障：连接认证成功、页面显示聆听，但服务端输入 PCM=0。iPhone 控制台证明 tap 未触发；引擎启动后发生 AVAudioEngineConfigurationChange，图停止并取消初始化。静音输入支路/显式输出连接实验无效，已移除。
- 启动期配置变化现按最新硬件格式重装 tap 并重启，最多两次；已有采集或静音时配置变化结束通话，不隐式恢复麦克风。回调到达标记复用 CaptureGate 的锁；停止/静音/旧引擎身份围栏保留；恢复时清理旧播放时间线；析构移除通知观察者。
- 同一五秒真机检查从 0 帧 FAIL 变为 49 帧 PASS。用户已确认“现在有回复了”，服务端记录真实 PCM 输入、音频输出及 playback.started；整体听感、长通话和耳机路线仍需继续验收。
- DEBUG 启动参数 `--check-capture` 可运行五秒本地采集检查；仅计数、不保存或上传录音，正常启动不自动开启麦克风。测试失败通过日志 result=FAIL 报告。
- 标题更改为 NovaAudioAgent，移除副标题。使用原生 Canvas 240 粒子参考桌面星云；真实 RMS 驱动向内收拢、星点大小及亮度，按用户反馈增强幅度。Reduce Motion / 静音 / 后台停止动态效果。
- Terra 定向复审无阻塞项；外部 Claude 指定模型确认配置变化根因方向，并提出静音与播放时间线问题，均已处理。原始报告保存在忽略的 build/ios-checkpoint/audio-claude-review.log。
- 固定合成短句经私网 WSS，最后有声帧到首个返回音频包 1688ms（一次测量，不代表真实手机分位数）。当前采用 smart_turn；是否改为 500ms 声学停顿判定等待用户体验偏好，不宣称延迟优化已完成。

### 2026-09-05 多供应商接入首轮

- [x] 认证 hello/ready 增加向后兼容的媒体能力协商；生产配置提供实际 integrated/cascaded 管线。
- [x] 不兼容 offer 在 Runtime admission 前拒绝；手机在开麦前拒绝未知媒体路径/owner。
- [x] 主屏精简为空闲星云、单条状态、真实字幕及通话按钮。
- [x] 官方 AOQ iOS SDK 1.2.0 Swift 导入与公开接口编译核验；未嵌入生产 App。
- [ ] AOQ Token/纯聊天真机 PoC、打断归属和 A/B 门槛（详见 `10-ios-aoq-evaluation.md`）。


### 2026-09-06 AOQ 纯聊天 checkpoint

- [x] 独立后端模式 relay(default)/aoq_chat；固定官方凭证代理、限流/一次领取/断线回收；不加载工具 Runtime。
- [x] iOS SDK adapter、设备签名嵌入、设置偏好、唯一音频 owner 与后台/断线清理。
- [x] 星云轮廓稳定与相位连续修复。
- [x] 49 后端回归、11 Swift 检查、签名设备构建。
- [ ] 实际 Token 申请、AOQ 真机语音/打断、网络与 A/B 验收。
