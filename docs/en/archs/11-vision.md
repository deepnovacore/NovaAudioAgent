# 11. Native vision and independent monitoring

Camera access is native. There is no built-in camera MCP or image-to-text tool for the foreground model. Search, knowledge and user-configured external MCP retain their existing boundaries.

## Conversation vision

The desktop switch is off by default. Only the current cascaded LLM and its adapter's verified image capability can enable it (`vision-capability.ts`). Unknown models and Qwen Audio Realtime cannot enable vision. No fallback model is called.

Each submitted voice transcript or text turn captures one JPEG from the system default camera. Qwen receives an `image_url` content part; Ark receives `input_image`. Tool continuations reuse that turn's image. Completed history contains text, not old images; Ark starts the next logical turn from local text history rather than a server response chain containing images. Background notifications never capture. Capture failure continues the text turn with an explicit missing-frame notice. Response cancellation and session epochs fence late frames.

## Monitor / guard

The `vision` controller routes start/stop to hidden `watch` or `guard` executors. The executor owns permission admission, a camera session, sampling, independent `watch_model` inference, report delivery, cancellation and final resource release. Audio-only foreground models can start it and receive reports.

Only one monitor may be active. Its device is fixed when the task starts. Defaults are 2.5-second sampling and a 30-minute window. Samples taking longer than the interval cause no catch-up queue. Three consecutive capture or inference failures terminate the task. A hit reports once and continues monitoring; two consecutive misses rearm reporting. Stop and timeout cancel in-flight capture and inference. Every exit closes the camera session in `finally`.

Desktop settings select the monitor camera and model using existing model connections. Built-in and USB cameras use exact Chromium device IDs; a missing/disconnected selected device fails without falling back. Conversation vision always uses the default camera. The renderer shares a stream between leases on the same device, and closes it after the last lease exits. Connection loss and app shutdown release leases. Device enumeration does not request camera permission; enabling conversation vision or starting monitoring does.

## Desktop protocol

Authenticated local `camera.capture` requests may carry paired `session_id` and `device_id` fields. An empty device ID means the default camera. `camera.release` carries `session_id` and releases only that lease. IDs are bounded, validated, host-generated and scoped to the connection. Legacy file capture remains available for deterministic tests.

Images and model observations remain untrusted evidence. Neither text visible in a frame nor a camera response can introduce host instructions. Network cameras, HA/RTSP, continuous video context and a separate foreground VLM selector are outside this implementation.
