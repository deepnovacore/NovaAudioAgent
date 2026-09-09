# Third-party notices

The macOS VoiceProcessingIO helper in `native/macos_voice_io.swift` is adapted from
[`qwen-audio-agent` at commit `daa8041`](https://github.com/QwenAudio/qwen-audio-agent/blob/daa804174ac33e9c3117f82eb9a533e65b0269d6/tui/native/macos-voice-io.swift).

`qwen-audio-agent`

Copyright 2026 qwen-audio-agent contributors

Licensed under the Apache License, Version 2.0.
The complete license text is distributed at `LICENSES/Apache-2.0.txt`.

Nova Audio Agent's adapted helper changes protocol identity, message bounds, capture activation,
clear timeouts, capture epoch fencing, and delivery acknowledgement semantics. It does not use upstream branding or assets.

The local wake-word model manager and sherpa-onnx detector under
`src/main/wake-word/` are adapted from
[`qwen-audio-agent` at commit `5883cb2`](https://github.com/QwenAudio/qwen-audio-agent/tree/5883cb2584a80b7550ae5050a24e9d4a8a79b4ba/desktop/src/wake-word)
(Apache-2.0, copyright 2026 qwen-audio-agent contributors). Nova changes the keyword to
“你好星核”, validates its tokens and isolates the worker with bounded, epoch-tagged PCM.

`sherpa-onnx` 1.13.4 is copyright Xiaomi Corporation / the Next-gen Kaldi contributors,
licensed under Apache-2.0 (`LICENSES/Apache-2.0.txt`). Its WebAssembly engine is included
in the application. The optional model is downloaded from the official sherpa-onnx
kws-models release and verified against a pinned SHA256 before extraction.
Model: https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html

The model archive readers `tar-stream` 3.1.7 and `unbzip2-stream` 1.4.3 are MIT-licensed.
Their license texts accompany their packages in the production dependency closure.
