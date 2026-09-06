# 火山级联语音验收

2026-09-05，macOS arm64，独立 worktree `feature/voice-focus`，基线 `4b90c99`。

本阶段沿用现有火山 ASR → Ark → 火山 TTS 和桌面内置回声消除、降噪、自动增益，不接入声纹或新的付费/本地降噪 SDK。

## 可重复运行

在仓库根目录执行（会调用真实服务并产生用量）：

```sh
npm run smoke:cascaded --workspace @nova-audio-agent/runtime -- \
  --env-file /absolute/path/to/test.env \
  --output /private/tmp/nova-cascaded-live-report.json
```

需要 `ARK_API_KEY` 和 `DOUBAO_BIGMODEL_API_KEY`；ASR 可单独设置 `DOUBAO_ASR_API_KEY`。其余参数沿用当前生产配置。脚本强制使用 cascaded + Ark，并在内存中剔除契约已退役的变量，报告剔除的键名；不会修改凭据文件。模型、语音和资源的访问权限仍由账号决定。

脚本使用生产 provider factories 和生产宿主 assembly；中文输入由真实 TTS 合成后以实时节奏输入，不读取麦克风，不保存音频或密钥。播放端使用数字确认回调，不声称验证了扬声器。宿主用例关闭外部执行器和工作区图，以避免访问实际用户工作区。

真实 Electron 后端验收（同样使用真实服务凭据）：

```sh
npm run smoke:node-backend --workspace @nova-audio-agent/ambient-orb -- \
  --cascaded --env-file /absolute/path/to/test.env
```

该模式使用临时能力配置关闭 Codex、摄像头与搜索，验证 `utilityProcess` 启动、readiness、带 token 的本地 WebSocket 握手、`desktop.ready` 和正常退出。普通默认模式仍保留原有 Codex bootstrap 检查，依赖本机 Codex 配置。

## 实际服务验收

| 用例 | 结果与覆盖 |
| --- | --- |
| 中文输入合成 | 通过；真实 TTS 返回约 3 秒 PCM |
| 音频 → ASR → Ark → TTS | 通过；验证发声起止、最终识别、回复音频与 completed 终态 |
| 生成中取消 | 通过；首个音频块后取消指定 response，只有一个 cancelled 终态 |
| 重连与工具续接 | 通过；epoch 增长，真实模型调用测试工具，注入工具结果后回复音频，事件归属新 epoch |
| 宿主播放、打断与恢复 | 通过；静音无回复，播放确认后触发本地发声事件，清空播放、产生 interrupted 交付；后续语音产生 spoken 交付，清空后没有旧 generation 音频 |
| Electron 级联后端启动 | 通过；真实 utilityProcess、本地 WebSocket 握手及退出，输出 `Node utility runtime smoke passed` |

最终数字音频 live 记录见 [JSON 报告](2026-09-05-cascaded-live-report.json)。该次音频闭环耗时 8039 ms，包括按实时节奏发送输入与静音，不是单纯的模型首包延迟。

宿主用例的发声事件由脚本调用 `localSpeechOnset` 注入，覆盖该事件之后的生产打断链路；不覆盖麦克风如何判定发声。工具返回值也是固定测试值，不涉及真实业务执行器。

## 本次修复

ASR 建连可能晚于会话关闭完成。旧逻辑会接收迟到的 session 并发送旧音频；迟到的失败也可能重置已被新 epoch 使用的端点检测。现在在建连成功/失败之后检查 owner：关闭迟到的资源，并忽略失效 owner 的失败处理。两个回归测试先复现失败，再验证修复。

同时修复旧 Electron smoke 的启动条件：补齐 `nodeResourcesPath`，避免在 ESM 入口顶层等待 `app.whenReady()` 阻塞启动，并加入截止时间和安全诊断码。

## 自动化回归

- `npm run check` 通过。
- 级联、火山协议及 assembly 专项 204 项通过。
- 全量 runtime 首次：2249 项，2215 通过、29 失败、5 跳过。其中 24 项受磁盘耗尽影响；恢复空间后，对相关文件复验 85 项，80 通过、5 失败。
- 剩余 5 项在独立、未修改的 `4b90c99` 副本同样复现：Codex 根导出契约 1 项、schema probe 2 项、camera manifest 1 项、Codex adapter 1 项。因此不宣称全库回归全绿。
- 桌面构建通过。默认并发测试中 native sandbox probe 超时，单测复验通过；以 `node --test --test-concurrency=4` 全量复跑后，814 项中 811 通过、0 失败、3 跳过。
- macOS 未运行 Windows 专用 source-startup smoke；未把平台跳过项计为通过。

## 尚不能自动签收的效果

本机实际端点模式是 `bounded_silence`，原因 `executor_unavailable`。LiveKit 导入可用不等于其语义端点模型已经运行。报告保留实际 capability/fallback 记录。

真实麦克风/扬声器回声、耳机切换，以及风扇、键盘、旁人说话下的误打断率仍需声学验收。当前没有目标说话人识别能力，不能保证旁人不会打断。桌面已有 `echoCancellation`、`noiseSuppression`、`autoGainControl` 请求；数字音频脚本绕过采集端，因此不能验证这些处理器的实际效果。
