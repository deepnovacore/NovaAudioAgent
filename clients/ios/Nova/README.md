# Nova iOS client

Native SwiftUI, iOS 17+, Swift 5, Xcode 16.4. No third-party packages. Open `Nova.xcodeproj`, select shared scheme **Nova**. Signing team and provisioning are supplied by the developer; they are not in this project.

Use **扫码连接主机** to scan the Mac pairing window (instructions below), or manually enter your private `wss://…` server and the 32-character lowercase-hex connection token. The client appends `/client/v1`; credentials are saved per server in Keychain (`WhenUnlockedThisDeviceOnly`), never in URLs or UserDefaults. The connection alone does **not** request microphone access or start recording. Tap **Start voice** in the visible connected UI to request permission and start voice. Denial leaves the client connected for captions and approvals.

A Debug build has an explicit localhost-only WS switch for the mock. Release rejects every non-WSS URL. Standard system TLS verification remains enabled. The local-network ATS allowance does not bypass the URL validator or TLS validation.

## Checks

From the repository root:

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/nova-ios-clang \
SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/nova-ios-clang \
swift test --disable-sandbox --package-path clients/ios/Nova \
  --scratch-path /private/tmp/nova-ios-swift-tests \
  --cache-path /private/tmp/nova-ios-swift-cache

xcodebuild test -project clients/ios/Nova/Nova.xcodeproj -scheme Nova \
  -destination 'platform=iOS Simulator,name=<installed iPhone simulator>' \
  -derivedDataPath /private/tmp/nova-ios-build CODE_SIGNING_ALLOWED=NO
```

`NovaTests` and the standalone Swift package share the protocol/playback checks; `NovaTests` also contains an iOS-only stop/connection lifecycle regression. After the review fixes, 9 Swift-package tests passed and all 10 iOS tests compiled successfully (not executed here without a simulator runtime). Unsigned device SDK compilation also passed. The former bundles the repository's shared `fixtures/client-protocol/v1/vectors.json`; the latter reads that exact file directly. No tests start audio or request microphone permission.

On this Mac (2026-09-05), Xcode 16.4 includes the 18.5 SDK but has no available simulator runtime. Destination-based builds report “iOS 18.5 is not installed.” Direct SDK compilation verifies both app and tests without a runnable simulator:

```sh
xcodebuild -project clients/ios/Nova/Nova.xcodeproj -target NovaTests \
  -configuration Debug -sdk iphonesimulator \
  SYMROOT=/private/tmp/nova-ios-sdk-build OBJROOT=/private/tmp/nova-ios-sdk-obj \
  CODE_SIGNING_ALLOWED=NO build
```

For a generic device build use `-target Nova -sdk iphoneos`. The parent handles signing/install; pass `DEVELOPMENT_TEAM` at build time. Do not interpret SDK compilation as simulator execution or hardware acceptance.

## Mock and controls

Have the runtime owner build the runtime, then start `node runtime/scripts/client-protocol-mock.mjs`. Connect a simulator to `ws://127.0.0.1:8787` with the Debug switch and public mock token documented in `docs/protocols/client-v1.md`. The mock is synthetic and does not use models or Codex. A native, microphone-free smoke check is also runnable against a mock started with `--port=18787`:

```sh
xcrun swiftc -D DEBUG -module-cache-path /private/tmp/nova-ios-clang \
  clients/ios/Nova/Nova/Protocol/Wire.swift clients/ios/Nova/Checks/MockCheck.swift \
  -o /private/tmp/nova-ios-mock-check
/private/tmp/nova-ios-mock-check
```

This check passed against the runtime mock: ready, Unicode caption, NOVA audio, command receipt and a separate authoritative project confirmation. It caught and guards the requirement to echo the server connection ID exactly, without UUID case normalization. It sends audio immediately; before Start voice, that audio is suppressed and reported with zero played time.

Project and executor cards carry the exact host proposal/approval IDs. The UI follows `allowed_decisions`, including session permission only when offered. Clicking submits one command; `applied` means delivered to the host callback. Cards wait for authoritative host state and expire locally. Disconnection removes cards, queued controls and audio. Neither approvals nor media are retried. Connection failures use at most three retries with 1/2/4-second backoff; a new handshake does not replenish this budget until the connection has stayed healthy for 30 seconds. Local post-handshake frame errors are retryable protocol failures; only local handshake incompatibility is classified as 4006, and explicit server close codes keep their meaning; authentication/version/busy refusals stop retrying. Code 4008 opens a fresh connection for the command budget. Restarted instance IDs are explicitly labeled; authorized tasks are not re-submitted or cancelled by this client.

## Audio and remaining device gates

AVAudioSession uses playAndRecord/voiceChat with native Voice Processing, automatic headphone routing and optional speaker override. AVAudioConverter resamples microphone hardware format to 16 kHz mono PCM16 little endian. AVAudioPlayerNode plays 24 kHz mono; the engine converts to the hardware output format. Playback allows 60 seconds of unplayed audio (1440000 samples, 5.76 MB Float32) plus a 512-buffer ceiling, accommodating synthesis faster than playback. Uplink has one capture handoff plus a 128 KiB / 128-message send bound and five-second send watchdog.

Playback time comes from player render sample time minus the live `player.outputPresentationLatency` (Voice Processing plus downstream device presentation, counted once); zero/unknown latency conservatively credits only completed buffers; `dataPlayedBack` confirms completed buffers. Scheduled ranges exclude underrun gaps. Generation tickets fence delayed callbacks after clear/disconnect. Terminal alone never completes playback; the final acknowledgement waits for played-back callbacks. Locally detected speech clears playback immediately, reports played time, then reports `speech.onset`. RMS onset uses native AEC output with 50 ms attack / 180 ms hangover and an exposed threshold to calibrate on actual hardware.

Foreground only: stopping active voice, backgrounding, interruption and media-service reset close the connection via the existing release path. Relay additionally closes on route changes. AOQ lets its SDK manage routing (including capture startup notifications); actual capture/playback failures still close the connection. Reconnect explicitly to resume. Reconnect restores host state but requires Start voice again. Muting removes the capture tap while retaining playback and sends synthetic 20 ms zero PCM packets at 16 kHz, so sample-driven endpointing can finish before unmute. Timer jitter preserves the cadence and missed ticks are skipped rather than uploaded in a burst. No background audio mode, APNs, camera, or automatic microphone restart.

**Runtime input boundary:** remote connection release now replaces the provider session while preserving the host graph and authorized workers. Pending PCM, retired-epoch events and delayed transcript admissions are fenced. Real endpointing regressions verify speech A is discarded before speech B. A failed replacement keeps input closed; Stop/connect retries the replacement without restarting host work. Provider-bound confirmations are invalidated and require fresh host state.

**Unverified hardware gates:** iPhone/AirPods/speaker AEC, actual stop latency, permission/interruption behavior, Wi-Fi/cellular/Tailscale switching, and the real project → Codex approval → result roundtrip. Device and signing are coordinated by the parent. No microphone recording was started during implementation.

## Visual assets

The interface uses midnight ink, mint accents, a voice orb and a compact call dock. Status changes announce through VoiceOver and the orb respects Reduce Motion. The generated 1024px opaque icon master is `Nova/Assets.xcassets/AppIcon.appiconset/AppIcon.png`. Five resized PNGs in `Nova/Icons` are bundled through `CFBundleIcons` for iPhone/iPad. The catalog is retained as source only: Xcode 16.4's `actool` requires an installed simulator runtime even for this device build, so ordinary PNG resources keep local device builds usable without that download. App Store packaging should be validated separately before distribution.

A Debug device build accepts `--check-capture` for a five-second local microphone smoke check (permission required). Run with `xcrun devicectl device process launch --terminate-existing --console --device <device> com.nova.remote-client --check-capture`; inspect `[capture-check] frames=… result=PASS|FAIL`. It stores/transmits no audio. Normal launches still require Start voice. The real-device startup regression was 0 frames before handling engine configuration changes and 49 frames after recovery.

### 2026-09-05 media negotiation checkpoint

The app now offers only its implemented `host_pcm_v1` transport. It validates the host-selected relay path, client audio owner and integrated/cascaded pipeline before admitting the connection. Old v1 hosts remain compatible; an explicit unsupported descriptor fails closed. Production derives this descriptor from the same settings that construct the provider. The home screen now has one status line and only shows the conversation card when captions exist.

Validation: 37 runtime protocol/entry/remote-session regressions, 10 Swift package checks, targeted TypeScript lint, signed device build and the running headless service's negotiated handshake passed. The updated app installed on the paired iPhone; automatic launch was refused because the phone was locked, so this checkpoint does not claim a new visual or voice acceptance. AOQ SDK import/typecheck passed separately, but AOQ is not embedded or enabled; see the evaluation spec for outstanding direct-media gates.


### AOQ direct modes

Run `sh clients/ios/Nova/scripts/fetch-aoq.sh` once before device builds to download the pinned official iOS SDK (SHA-256 checked, `Vendor/` ignored). Device builds link/embed/sign it; simulator builds retain relay only. Phone settings offer Follow host / Relay / AOQ. Auto and AOQ preferences offer both `qwen_aoq_runtime_v1` and the existing `qwen_aoq_chat_v1`; the host selects one, while relay remains available in Auto. Changing the phone preference never changes server configuration or permissions.

AOQ requests a fresh credential only after Start voice and microphone permission. The SDK owns capture/AEC/playback; the native relay engine stays stopped. In Runtime mode the host owns `session.update`; bounded non-audio SDK JSON events cross the control socket as ordered `aoq.event` envelopes, and strictly sequenced supported `aoq.command` events return to the SDK. `session.updated` enables capture once in either mode. Runtime permits host tools and reuses the normal project, executor, caption, clock and command-result handling; chat mode still refuses tools. AOQ playback clear interrupts the SDK player without inventing played receipts, while terminal is ignored because the native playback engine owns no AOQ media. End/background/host loss stops the SDK. Camera remains unavailable. Real-device voice/network and per-response heard-time evidence remain pending.


## 扫码连接

所有连接模式（Relay、AOQ Chat、AOQ Runtime）共用同一套扫码配对。手机打开连接设置 → **扫码连接主机** → 确认二维码中的 WSS 地址；配对后自动连接，仍需点击“开始对话”才会请求麦克风并开始音频。

Mac 启动本 worktree 的新版 headless 服务后，在使用相同 `NOVA_AUDIO_AGENT_SERVER_PORT`、`NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE` 环境配置的终端运行：

```sh
npm run server:pair --workspace @nova-audio-agent/runtime -- wss://你的主机.ts.net
```

原生 Mac 窗口显示 120 秒内有效的一次性二维码，并可刷新二维码、查看和撤销设备。刷新会让上一张码失效；关窗会尝试取消当前码，强制退出时最迟到期失效。配对后二维码自动隐藏。二维码使用 macOS CoreImage，扫码使用 iOS VisionKit，没有新增第三方依赖；Mac 运行窗口需要 Xcode Command Line Tools。

二维码只包含 WSS 地址、一次性配对码、协议版本和到期时间，不包含主机长期 token 或模型 API Key。每台手机兑换独立的 32 位 token 并保存到 Keychain；主机只保存其 SHA-256 哈希。撤销设备会立即关闭其已有连接，并拒绝以后重连。手填旧主机 token 仍兼容；它不属于单独可撤销的手机凭据。

配对需要相机权限，拒绝权限或设备不支持 VisionKit 时可手填。二维码不提供网络穿透：手机仍须能访问该 WSS 地址，例如已加入对应 Tailscale 网络。地址确认不会触发麦克风；取消、超时、退到后台均不应保存迟到的配对响应。若兑换成功后网络中断或 Keychain 写入失败，可在 Mac 撤销该设备并重新生成二维码。

新增验证：`runtime/test/client-pairing.test.ts` 覆盖过期、一次性兑换、凭据持久化/隔离和 Relay/AOQ 撤销；Swift package 覆盖二维码协议校验。Mac 二维码可运行 `swift runtime/scripts/pair-device.swift --check` 做生成/解码自检。相机实扫和真实私网配对仍需 iPhone 验收。



## 飞书登录

公开客户端仅提供登录按钮及 PKCE 回调处理。部署方通过 Info.plist 的 `NovaFeishuLoginOrigin` 配置 HTTPS 登录站点，未配置时按钮禁用且不会探测网络。站点需实现 `/nova/health`、`/auth/nova/start` 和 `/nova/exchange`；凭据只接受同源 `wss://<host>/client/v1`，不随 HTTP 重定向转发授权码。公开构建不包含员工工作台、周报或公司部署配置。

## 级联可编辑输入

主机声明 `text_input` 和 `dictation` 后显示输入框。按住录音、松开转草稿，可编辑后再发送；识别本身不触发模型或工具。取消、断线与识别失败保留原草稿。真机效果需按所用服务配置验收。
