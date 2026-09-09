# Nova private client protocol v1

Remote endpoint: `/client/v1`, WSS via Tailscale Serve. Local mock/simulator may use WS on loopback. This endpoint never exposes camera or debug-board requests. Desktop `/` remains a separate legacy endpoint.

The first frame is text, within 3 seconds:

```json
{"type":"hello","token":"0123456789abcdef0123456789abcdef","protocol_version":1}
```

Token is 128 random bits, lowercase hex, provisioned locally and stored in iOS Keychain. The example is for the mock only. Do not put credentials in a URL. Authentication precedes any state or audio. Failure closes 4003; unsupported protocol version closes 4006; unsupported path closes 4004; a concurrent client closes 4009.

Authenticated response (IDs below are examples):

```json
{"type":"client.ready","protocol_version":1,"server_instance_id":"server-uuid","connection_id":"connection-uuid","input_audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},"output_audio":{"encoding":"pcm_s16le","sample_rate":24000,"channels":1},"capabilities":["audio","captions","projects","executor"]}
```

These formats match the existing desktop/Qwen pipeline: input 16 kHz, output 24 kHz, mono signed PCM16 little endian. iOS must resample device input, which is often 48 kHz. Unsupported formats must be refused, not silently played at the wrong speed. No compressed audio negotiation in v1.

## Media

Uplink binary frames: 1–65536 bytes, even length, raw PCM16. Downlink: existing `desktop-wire.ts` NOVA framing: four ASCII magic bytes, a two-byte big-endian JSON header length (maximum 2048), header UTF-8 bytes, then PCM16. Header fields: `utterance_id`, `generation_epoch` (positive safe integer), `sequence` (nonnegative safe integer). Never parse a length before checking available bytes. Decode non-ASCII identifiers and reject unrepresentable integers rather than rounding.

Golden vectors: `fixtures/client-protocol/v1/vectors.json`, an array of `{name, hex, valid, expected?}`. Expected has `utterance_id`, `generation_epoch`, `sequence`, `pcm_hex`.

Downlink text uses the existing `caption`, `playback.clear`, `playback.alert`, `playback.terminal`, `project.state`, `executor.state`, `executor.progress`, `executor.result`, `executor.results.reset`, `executor.approval`, and `clock.ping` payloads. Their authoritative encoders are `desktop-wire.ts`, `desktop-progress.ts`, and `desktop-bridge.ts`. Client must not treat terminal as proof that audio already played.

## Controls and receipts

Wrap existing selected desktop controls:

```json
{"type":"client.command","request_id":"request-uuid","connection_id":"connection-uuid","payload":{"type":"project.confirmation_decision","proposal_id":"proposal-1","confirmed":true}}
```

Allowed payloads are the existing desktop control schema: `speech.onset`, `playback.started/stopped/done/cleared`, project/approval decisions, clock pong and diagnostics/telemetry. Camera and arbitrary tool execution are rejected. The optional `scope: "session"` on an affirmative executor decision is valid only when the current host approval offers it; the UI must follow `allowed_decisions`.

```json
{"type":"client.command_result","request_id":"request-uuid","status":"applied"}
```

`applied` is a delivery receipt from the host callback, **not** proof that a proposal was accepted or a task executed. Host state events decide that. `rejected` means conflicting retry, capacity, or callback failure; `stale` means wrong connection ID. Each connection remembers at most 256 controls, including failed ones. Same ID + same normalized payload returns the original receipt; changed payload cannot redeliver. At capacity the server closes 4008 after the receipt and the client reconnects for a fresh snapshot. Controls are serialized; never automatically retry approvals across a connection boundary.

Text controls are limited to 16 KiB; numbers must be finite, integers safe in JS. Input buffering is bounded at 256 KiB / 128 pending messages and output at 256 KiB / 128 pending sends. Exceeding limits retires the current connection. This does not stop the Runtime graph. No audio backlog replay after reconnect.

On disconnect clear local audio and actionable approval UI. New ready means use its connection ID. Same server instance restores in-memory project/work/result state; a different instance means a restarted service, not transparent task recovery. A client ending the call disconnects; it does not cancel a Codex task.

## Mock

After building runtime, run `node runtime/scripts/client-protocol-mock.mjs`. It listens on localhost:8787 by default and uses only the example credential above. It never calls models or Codex, records no microphone audio, and emits a short synthetic tone plus clearly marked mock state. `--disconnect-after-ms=3000` exercises recovery. Mock output cannot establish real voice/Codex or Tailscale acceptance.

## Media selection (backward-compatible v1 extension)

New clients include `media: {transports: ["host_pcm_v1"]}` in `hello`.
The authenticated host selects its configured pipeline and returns in `client.ready`:

```json
{"media":{"transport":"host_pcm_v1","path":"relay","audio_owner":"client","pipeline":"integrated"}}
```

`pipeline` is `integrated` or `cascaded`, derived from the same validated settings used to construct the production provider. It is independent of the media path. Qwen integrated and the supported Volcengine cascaded configuration use the same transport, approval UI, connection identity and PCM formats. No provider credentials, URLs, raw events or SDK objects cross this contract.

An omitted offer means the original v1 relay. An explicit offer must contain 1–8 bounded transport names and include `host_pcm_v1`; otherwise the server closes with 4006 **before** Runtime admission. A client offering both AOQ and relay receives an explicit relay selection; AOQ-only is rejected. Unknown fields in the offer are rejected. New iOS clients accept old hosts without `media`, but reject any explicit unsupported path, owner, pipeline or malformed descriptor before microphone activation. There is one media path per connection; switching requires disconnect/reconnect. `connection_id` and existing playback/provider generations retain their distinct ownership; this extension does not fabricate a provider session identity in `client.ready`.

Direct mode and provider-control messages are deliberately not enabled: accepting raw provider events as `client.command` or returning an AOQ token would not preserve the existing authorization/playback contracts. AOQ requires the separate validation gates in the evaluation spec.

Unconfigured/test transports omit `media` rather than invent a production pipeline. Configured descriptors are strictly validated and copied before the listener is allocated; extra fields (including credentials) are rejected.

## AOQ Runtime extension

Clients explicitly offer `qwen_aoq_runtime_v1`. Ready selects `{transport:"qwen_aoq_runtime_v1",path:"direct",audio_owner:"aoq_sdk",pipeline:"integrated",mode:"runtime"}` and audio/captions/projects/executor capabilities. This is separate from `qwen_aoq_chat_v1`, which remains chat-only.

After `aoq.connect` the host issues connection/request-bound credentials with `mode:"runtime"` and no session configuration. The SDK establishes the model connection and forwards Data events as `{type:"aoq.event",connection_id,sequence,event}`. The host's existing Qwen adapter generates the sole `session.update`, including Runtime tools, through `{type:"aoq.command",connection_id,sequence,event}`. Each direction starts sequence at 1 and requires consecutive values. Events are bounded at 64 KiB, envelopes at 128 KiB, queued bytes at 256 KiB; ordinary control frames retain their original limits and command deduplication.

Binary/PCM/audio payload events are rejected. Provider events are directionally allowlisted; incremental and ambient ASR metadata never provide execution authority. Only completed user transcript evidence reaches the existing Runtime origin binding. Existing project/executor events and `client.command` carry host UI decisions. Provider messages are processed independently of awaited UI commands so replies cannot deadlock behind commands that await them.

Authentication refusal remains 4003. In AOQ Runtime, post-authentication protocol rejection uses 1002; it must not be presented as an invalid key. No AOQ event is translated into a fabricated playback completion.

## QR pairing v1

All media modes share pairing; the existing `hello` and media protocol are unchanged.

- QR payload: `{type:"nova.pair",version:1,server:"wss://host/client/v1",code:<32 lowercase hex>,expires_at:<Unix milliseconds>}`. WSS only; reject userinfo/query/fragment and unrelated paths. The client shows the destination before exchange.
- `/client/pair`: send one text frame `{type:"pair.redeem",code,device_name}`. Success: `{type:"pair.ready",token,device_id}`; failure: `{type:"pair.error",message}`. A socket closes after one response. No microphone, model allocation or host controls are admitted here.
- `/client/pair-admin`: one text request authenticated with the master `token`. `pair.create` takes `server` and returns the QR payload; `pair.list` returns `{type:"pair.devices",devices:[{id,name,created_at}],pairing_active}`. Optional `code` checks whether that specific invitation remains active. `pair.revoke` takes `device_id`; `pair.cancel` takes `code`; both return the current device list. A device token cannot call these operations.
- One active 128-bit random invitation per process, valid 120 seconds, consumed synchronously after durable device registration. New invitations replace old ones. Up to 8 concurrent pairing/management sockets, 4096-byte requests, five-second socket lifetime, 60 redemption attempts/minute per host and 32 registered devices.
- Each successful exchange issues a distinct 128-bit device token. The private store persists only token hashes and is bound to the master token. Relay and both AOQ modes accept these in their normal `hello`. Revoking a device persists the removal before closing its active sockets with 4003.
- Pairing requests/credentials must not be logged, placed in URL parameters or automatically retried. If delivery or local Keychain persistence fails, regenerate an invitation and remove the orphan device entry. Network reachability/TLS remains a prerequisite.


