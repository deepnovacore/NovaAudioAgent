# 自托管语音与预置配置

Nova 在本机负责麦克风采集、端点检测、会话状态、工具授权、播放与打断。ASR、LLM、TTS 通过可替换的网络端点提供服务。模型依赖和 GPU 进程放在独立的 `serving/`，不进入 Nova 运行时依赖。`serving/` 是面向源码检出的参考实现：桌面安装包和 npm 包都不包含它；你也可以直接把 Nova 指向自己已有的兼容端点。

## 启动参考实现

当前参考启动器支持 Linux + NVIDIA CUDA，使用 faster-whisper、vLLM 和 Breeze TTS，默认分配两个 GPU。将来 Mac 上的实现可以提供相同协议，无须改动 Nova 会话管线；本启动器尚不安装 Mac 推理引擎。

在 GPU 机器上将 `serving/profile.4090.example.json` 复制为私有 `serving/machine.local.json`，按需修改 GPU 编号、端口和存储路径，在仓库根目录执行：

```sh
python3 serving/serve.py --profile serving/machine.local.json up
python3 serving/serve.py --profile serving/machine.local.json status
python3 serving/serve.py --profile serving/machine.local.json export > voice-preset.json
python3 serving/serve.py --profile serving/machine.local.json stop
```

`up` 安装独立环境、下载缺少的模型并启动三个服务，复用已有环境和模型目录。下载需要联网和足够磁盘空间。`start` 跳过安装；相同配置已健康运行时，重复启动直接成功。日志和进程记录位于配置的状态目录。`stop` 仅停止身份仍与记录匹配的自有进程；修改机器配置前先停止其服务。

可通过 `envs: {llm, asr, tts}`、`models: {llm, asr, tts}` 和 `breeze_source` 复用已有路径。GPU、端口、LLM 显存预算/上下文以及可选模型仓库和版本映射属于机器配置，不应放进共享预置。这是指定模型的参考实现，不是任意模型架构的通用启动器。使用或分发模型输出前应阅读各模型许可证，部署不会改变其许可条件。

启动器需要 Python 3.11 或更新版本，自身不提供远程控制：请在 GPU 机器上执行 `up` 和 `stop`，例如放在 `tmux` 里。不支持在 `up` 过程中 SSH 会话断开。

服务只监听回环地址。在 Mac 上转发配置的端口，保持 SSH 连接：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 18101:127.0.0.1:18101 -L 18102:127.0.0.1:18102 -L 18103:127.0.0.1:18103 gpu-host
```

替换为自己的 SSH 主机别名和配置端口。

**参考服务不校验令牌，也不校验浏览器来源。** 任何能连到端口的对象都可以使用你的 GPU，并占满唯一的 ASR/TTS 槽位：共享 GPU 机器上的其他用户，以及转发开启期间 Mac 上的任何本地进程或网页。空闲时关闭转发，或在前面放置带认证的 TLS 反向代理。Nova 里可选的令牌字段会作为 Bearer 发给这类代理；参考服务会忽略它们。

## 导入与导出

打开“设置 → 语音管线”，导入生成的 JSON，检查显示的地址和模型，再保存。导入只暂存修改，未出现的阶段保持不变。导出包含已选择且支持的阶段：自托管 ASR/LLM/TTS、火山 ASR、DeepSeek LLM。云端阶段使用已保存的 API 密钥及已有服务端点；记忆嵌入模型和执行器配置不属于本格式。

```json
{
  "schema": "nova.voice-preset",
  "version": 1,
  "name": "自托管语音",
  "asr": {"provider": "self-hosted", "url": "ws://127.0.0.1:18102/v1/audio/stream"},
  "llm": {"provider": "self-hosted", "baseUrl": "http://127.0.0.1:18101/v1", "model": "Qwen/Qwen3.5-4B"},
  "tts": {"provider": "self-hosted", "url": "http://127.0.0.1:18103/v1/audio/speech"}
}
```

混合预置的云端 ASR 使用 `{"provider":"volcengine"}`，LLM 使用 `{"provider":"deepseek","model":"your-model"}`，再组合自托管 TTS 阶段。实际部署预置保存在 Git 之外。端点协议与模型无关：模型路径、GPU 和音色留在服务实现中。替换 TTS URL 即可接入满足下方协议的服务，但不代表兼容任意厂商 API。

未知字段/版本、超过 64 KiB 的文件会整体拒绝。支持远程 HTTPS/WSS，明文只允许字面量回环 IP；禁止 URL 内凭据、查询串和片段。ASR/LLM/TTS 使用各自独立的可选密钥，导出不包含密钥。修改端点 origin 会清除旧密钥，可以同时填写新地址及对应的新密钥并保存；不会复用已有云服务密钥。

没有单独覆盖时，辅助模型跟随所选会话模型。记忆嵌入、搜索及其他服务仍使用自身配置，因此仅选择自托管语音不等于整个应用完全离线。

无界面运行时设置 `PIPELINE_MODE=cascaded`、各阶段 `CASCADE_*_PROVIDER=self-hosted`、`CASCADE_LLM_MODEL`，以及 `SELF_HOSTED_ASR_URL`、`SELF_HOSTED_LLM_BASE_URL`、`SELF_HOSTED_TTS_URL`。可选 `SELF_HOSTED_{ASR,LLM,TTS}_API_KEY` 提供独立 bearer token。
## 通信协议与验收

- ASR：WebSocket 二进制输入为单声道 16 kHz 小端 PCM16；服务先发送 `{type:"ready",sampleRate:16000,format:"s16le"}`。一句音频结束后发送文本 `finish`。转录 `{text,final,replace:true}` 是完整替换假设，唯一 final 结束该句；关闭连接表示取消。
- LLM：兼容 OpenAI 的流式 `/chat/completions`，包括结构化工具调用和结果回传，模型由配置选择。
- TTS：HTTP POST multipart `text` 和 `instruction`，流式返回单声道 24 kHz 小端 PCM16，响应头为 `Content-Type: audio/pcm`、`X-Sample-Rate: 24000`、`X-Sample-Format: s16le`。断连必须释放合成资源；Nova 按顺序提供语音片段，打断时取消当前任务。

运行 `python3 -m unittest discover -s serving` 可执行无需模型的启动器检查（进程生命周期检查需要 Linux）。构建 runtime、转发端口后，运行真实适配器检查：

```sh
node serving/smoke.mjs voice-preset.json prerecorded-16khz-mono.s16le
```

此检查覆盖 ASR 最终转录、LLM 工具调用往返、TTS 取消及后续合成，再将预录音频送入生产会话语音管线，确认返回完整的音频回复。不采集麦克风，也不证明回声消除、扬声器播放和真实会话延迟体验已验收。

## Mac 模拟输入与本地 ASR

CUDA 启动器仍仅支持 Linux。Mac 上可以用已安装的系统语音生成固定输入，不开启真实麦克风，再转换为单声道 16 kHz PCM：

```sh
mkdir -p output
say -v Tingting -o output/mock-mic.aiff '你好，这是本地语音测试。请用一句话回答。'
ffmpeg -nostdin -y -i output/mock-mic.aiff -ar 16000 -ac 1 -f s16le output/mock-mic.s16le
node serving/mock-smoke.mjs output/mock-mic.s16le
```

脚本临时启动回环 ASR/LLM/TTS 假服务，以麦克风大小的音频帧驱动生产管线，检查工具往返、修订字幕、PCM 奇数字节分块、取消及后续合成。转录文本、模型回复和 TTS 音调都是 mock，不是模型效果指标。不会录制或播放物理音频。

还可以用已有的 `openai-whisper` Python 环境和本地 `.pt` 权重，执行**真实本机 CPU 转录**：

```sh
python serving/mac-asr-smoke.py --model /path/to/base.pt --audio output/mock-mic.aiff --expect 本地
```

此命令不会下载模型。通过只代表本机 ASR 对该合成样本有效，不代表 Mac LLM/TTS serving、麦克风权限、回声消除或扬声器播放已验收。此前 4090 的 smoke 使用真实远端模型，与这里的假服务独立。

参考安装把 Breeze 源码以及 LLM、Whisper、TTS 权重都固定到确切 commit，新部署可复现。若要试用更新的权重，在机器配置的 `model_revisions`（`llm`、`asr`、`tts`）中指定，并在之后重新跑验收。
