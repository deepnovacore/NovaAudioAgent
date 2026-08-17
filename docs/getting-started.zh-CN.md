# 上手指南

## 安装

基础环境需要 Python 3.11+、[uv](https://docs.astral.sh/uv/) 与支持 submodule 的 Git；
Ambient Orb 还需要 macOS、Node.js 22+、麦克风权限和 `codex` 可执行文件。

```bash
git clone --recurse-submodules \
  https://github.com/deepnovacore/NovaAudioAgent.git nova-audio-agent
cd nova-audio-agent
uv sync --dev
cp .env.example .env
```

文本模型至少配置 `NOVA_AUDIO_AGENT_MODEL_API_KEY`，搜索配置 `TAVILY_API_KEY`。文本 CLI：

```bash
uv run nova-audio-agent chat --executor fast_sim
```

## 实时语音 provider

启动时通过 `NOVA_AUDIO_AGENT_REALTIME_PROVIDER=qwen|volcengine` 选择，默认是 `qwen`；
不会在运行中自动 failover。

Qwen 的最小配置：

```dotenv
NOVA_AUDIO_AGENT_REALTIME_PROVIDER=qwen
DASHSCOPE_API_KEY=...
```

火山引擎备选是原生级联管线：

```text
16 kHz PCM16 → Silero VAD v5.1.2 → Seed ASR → Doubao Seed 2.0 Pro → Seed TTS 2.0 → 24 kHz PCM16
```

先安装可选依赖：

```bash
uv sync --extra vision --extra volcengine --dev
```

然后在火山控制台开通 Seed ASR 2.0、目标 Ark 模型与 Seed TTS 2.0，并配置：

```dotenv
NOVA_AUDIO_AGENT_REALTIME_PROVIDER=volcengine
ARK_API_KEY=...
DOUBAO_ASR_API_KEY=...
DOUBAO_BIGMODEL_API_KEY=...
TAVILY_API_KEY=...
```

如果 ASR 和 TTS 共用同一把 key，可以不填 `DOUBAO_ASR_API_KEY`，程序会复用
`DOUBAO_BIGMODEL_API_KEY`。凭据不要写入代码、测试或提交历史。

Ark 默认模型是 `doubao-seed-2-0-pro-260215`，使用 Responses API 原生工具调用，开启
`store` 与 `previous_response_id`，关闭深度思考和并行工具调用。工具结果按原 `call_id`
回传。若同一响应已经输出普通文本，之后又出现工具调用，适配器会取消 TTS、拒绝执行该工具并
以失败终止，避免“先说后执行”的副作用。

TTS 在首个自然标点立即 flush，之后按 18 字 soft / 48 字 hard 分块。连接失效时，只有当前
响应尚未输出任何音频才会重连重试一次；已经输出首音后绝不重试，避免重复播报。

### 火山配置

除三项无前缀凭据外，下表变量均带 `NOVA_AUDIO_AGENT_` 前缀：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `ARK_API_KEY` | — | Ark Responses API |
| `DOUBAO_ASR_API_KEY` | 复用 TTS key | Seed ASR |
| `DOUBAO_BIGMODEL_API_KEY` | — | Seed TTS 2.0 |
| `VOLCENGINE_ARK_BASE_URL` | Ark API v3 | 必须为 `https://` |
| `VOLCENGINE_ARK_MODEL` | `doubao-seed-2-0-pro-260215` | LLM 模型 |
| `DOUBAO_ASR_ENDPOINT` | ASR v3 endpoint | 必须为 `wss://` |
| `DOUBAO_ASR_RESOURCE_ID` | `volc.seedasr.sauc.duration` | 可按账号改为 legacy resource |
| `DOUBAO_ASR_CHUNK_MS` | `200` | ASR 发包窗口 |
| `DOUBAO_TTS_ENDPOINT` | 双向流式 TTS endpoint | 必须为 `wss://` |
| `DOUBAO_TTS_RESOURCE_ID` | `seed-tts-2.0` | TTS resource |
| `DOUBAO_TTS_VOICE` | `zh_female_vv_uranus_bigtts` | 音色 |
| `DOUBAO_TTS_OUTPUT_SAMPLE_RATE` | `24000` | PCM16 输出采样率 |
| `VOLCENGINE_VAD_THRESHOLD` | `0.5` | Silero 阈值 |
| `VOLCENGINE_VAD_PRE_ROLL_MS` | `260` | 起点前音频 |
| `VOLCENGINE_VAD_MIN_SPEECH_MS` | `250` | 最短语音 |
| `VOLCENGINE_VAD_SILENCE_END_MS` | `560` | 判停静音 |
| `VOLCENGINE_VAD_SPEECH_PAD_MS` | `30` | 语音 padding |
| `VOLCENGINE_VAD_MAX_UTTERANCE_MS` | `15000` | 强制断句 |

Silero/ONNX 加载失败、凭据缺失或 endpoint 不安全时会拒绝启动，不会静默切到 energy VAD。
当前不实现声纹、人脸、唤醒词、说话人分离、TSE、A2F 或自动 provider 切换。

## Ambient Orb 与延迟探针

```bash
./scripts/start_ambient_orb_macos.sh
```

真实 provider 探针必须显式 opt-in，不进入默认 CI。用下面的方式录制无内容遥测，交互几轮后
结束进程并生成 p50/p95 报告：

```bash
NOVA_AUDIO_AGENT_REALTIME_TELEMETRY=/tmp/nova-volcengine.jsonl \
  ./scripts/start_ambient_orb_macos.sh
uv run python -m scripts.realtime_probe telemetry-report /tmp/nova-volcengine.jsonl
```

报告包含 `speech end → ASR final → LLM first text → TTS first audio` 各段耗时。遥测不记录
凭据、原始音频或完整对话文本。

也可以用一段无压缩、单声道、16 kHz PCM16 WAV 做有界端到端 smoke；没有 `--live` 时脚本
拒绝发起网络请求，并且不会打印转写或回答内容：

```bash
uv run python scripts/smoke_volcengine_realtime.py \
  --live --wav /absolute/path/to/utterance.wav --runs 3
```

其余 Home Assistant、Codex、AutoGLM、摄像头与完整公共配置见
[英文上手指南](getting-started.md)。

## 验证

```bash
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
uv build
```
