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


Downlink text uses the existing `caption`, `playback.clear`, `playback.alert`, `playback.terminal`, `project.state`, `executor.state`, `executor.progress`, `executor.result`, `executor.results.reset`, `executor.approval`, and `clock.ping` payloads. Their authoritative encoders are `desktop-wire.ts`, `desktop-progress.ts`, and `desktop-session.ts`. Client must not treat terminal as proof that audio already played.

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

## Media selection (backward-compatible v1 extension)

New clients include `media: {transports: ["host_pcm_v1"]}` in `hello`.

`hello` may also include `language: "zh-CN" | "en"`. The host validates this enum after authentication and before accepting input. It selects translated AI system instructions for this connection, including task narration; it does not translate user messages, force a response language, or change ASR/TTS models or voices. Omitting it restores the host's configured default (`PROMPT_LANGUAGE`, otherwise `zh-CN`), rather than inheriting the previous client's choice. Unsupported values reject the connection. Relay and both AOQ modes support the field; older hosts may ignore it. Clients reconnect to apply a changed language.

The authenticated host selects its configured pipeline and returns in `client.ready`:

```json
{"media":{"transport":"host_pcm_v1","path":"relay","audio_owner":"client","pipeline":"integrated"}}
```

`pipeline` is `integrated` or `cascaded`, derived from the same validated settings used to construct the production provider. It is independent of the media path. Qwen integrated and the supported Volcengine cascaded configuration use the same transport, approval UI, connection identity and PCM formats. No provider credentials, URLs, raw events or SDK objects cross this contract.

An omitted offer means the original v1 relay. An explicit offer must contain 1–8 bounded transport names and include `host_pcm_v1`; otherwise the server closes with 4006 **before** Runtime admission. A client offering both AOQ and relay receives an explicit relay selection; AOQ-only is rejected. Unknown fields in the offer are rejected. New iOS clients accept old hosts without `media`, but reject any explicit unsupported path, owner, pipeline or malformed descriptor before microphone activation. There is one media path per connection; switching requires disconnect/reconnect. `connection_id` and existing playback/provider generations retain their distinct ownership; this extension does not fabricate a provider session identity in `client.ready`.

Direct mode and provider-control messages are deliberately not enabled: accepting raw provider events as `client.command` or returning an AOQ token would not preserve the existing authorization/playback contracts.

Unconfigured/test transports omit `media` rather than invent a production pipeline. Configured descriptors are strictly validated and copied before the listener is allocated; extra fields (including credentials) are rejected.

## QR pairing v1

All media modes share pairing; the existing `hello` and media protocol are unchanged.

- QR payload: `{type:"nova.pair",version:1,server:"wss://host/client/v1",code:<32 lowercase hex>}`. WSS only; reject userinfo/query/fragment and unrelated paths. The client shows the destination before exchange. New invitations omit `expires_at`; updated clients still validate it when scanning an older server invitation.
- `/client/pair`: send one text frame `{type:"pair.redeem",code,device_name}`. Success: `{type:"pair.ready",token,device_id}`; failure: `{type:"pair.error",message}`. A socket closes after one response. No microphone, model allocation or host controls are admitted here.
- `/client/pair-admin`: one text request authenticated with the master `token`. `pair.create` takes `server` and returns the QR payload; `pair.list` returns `{type:"pair.devices",devices:[{id,name,created_at}],pairing_active}`. Optional `code` checks whether that specific invitation remains active. `pair.revoke` takes `device_id`; `pair.cancel` takes `code`; both return the current device list. A device token cannot call these operations.
- One active 128-bit random invitation per process, without time-based expiry, consumed synchronously after durable device registration. New invitations replace old ones. Up to 8 concurrent pairing/management sockets, 4096-byte requests, five-second socket lifetime, 60 redemption attempts/minute per host and 32 registered devices.
- Each successful exchange issues a distinct 128-bit device token. The private store persists only token hashes and is bound to the master token. Relay and both AOQ modes accept these in their normal `hello`. Revoking a device persists the removal before closing its active sockets with 4003.
- Pairing requests/credentials must not be logged, placed in URL parameters or automatically retried. If delivery or local Keychain persistence fails, regenerate an invitation and remove the orphan device entry. Network reachability/TLS remains a prerequisite.


### Editable input in cascaded mode

A cascaded host advertises `text_input` and `dictation` in `client.ready.capabilities`. These payloads use the existing `client.command`, bound to `connection_id` and `request_id`, with deduplicated receipts:

- `input.text`: `text` is non-empty user input, at most 4000 UTF-16 code units.
- `input.dictation`: `id` identifies the draft; `action` is start/finish/cancel. After start, binary PCM goes only to a bounded draft buffer (16 kHz PCM16, up to 60 seconds). Finish calls the configured cascaded ASR with a 30-second timeout; cancel or disconnection cancels recognition.
- `input.audio`: exits draft mode and explicitly resumes continuous voice. Late draft audio does not automatically enter the model.

Recognition returns `input.transcription` with the matching `id` and `text`, or only `error: recognition_failed` on failure. A draft is not a user turn and does not trigger an LLM or tools. The client must explicitly submit the edited `input.text`.

### Personal host and reliable text acceptance

The authenticated desktop socket accepts `personal.command` directly. Remote clients wrap the same payload in `client.command`; outer `client.command_result` acknowledges delivery to the control handler, while `personal.result` reports the domain operation:

```json
{"type":"personal.command","request_id":"request-uuid","method":"state","params":{}}
{"type":"personal.result","request_id":"request-uuid","ok":true}
```

Methods are `state`, `feed.action`, `memory.list`, `memory.correct`, `memory.forget`, `discovery.configure`, and `sources.add/pause/resume/disconnect/delete/sync`. Memory changes require `{id,expected_version}`; correction also requires `content`. Feed actions use `{id,action,snooze_until?}`. Actions are `open`, `act`, `snooze`, `dismiss`, `expand_evidence`, `presented`, and `notified`. Only explicit `act` requests enter the normal user authorization path. Discovery configuration accepts `{enabled?,interval_minutes?}` (5–1440 minutes, default 30). Directory admission requires explicit consent; clients cannot select the user scope or storage path.

The host sends `personal.state` with `{revision,feed,memory:{entries,cursor,overview?},sources,capabilities,settings}`. Treat these as authoritative snapshots; capability booleans govern available operations. A domain failure has `ok:false,error`. Request IDs are deduplicated against a bounded durable receipt ledger. Private memory/snapshot bodies are not retained in that ledger: replay of such a receipt includes `reload_required:true`. Request a fresh `state` or `memory.list` with a new request ID instead of assuming missing `data` is a complete result.

Text input retains compatibility with `{type:"input.text",text}`. New clients should use the correlated form:

```json
{"type":"desktop.capabilities","capabilities":["text_input","dictation"],"input_instance_id":"host-uuid"}
{"type":"input.text","request_id":"text-uuid","input_instance_id":"host-uuid","text":"Please review my notes"}
{"type":"input.text_result","request_id":"text-uuid","ok":true}
```

`input.text_result` is a required, non-droppable receipt. `ok:true` means the host's submission to the current provider resolved; it does not prove a task was completed. Captions, including identical final user text, never acknowledge input. Rejected submissions return `ok:false,error`, including `submission_failed`, `request_id_conflict`, `request_capacity`, or `outcome_unknown`.

The bridge retains at most 256 text request receipts for its runtime lifetime, without evicting accepted requests. Identical request ID/text retries reuse the original operation and receipt, including across renderer reconnect. Keep the original `request_id` and `input_instance_id` when retrieving a lost receipt. A different backend instance rejects the stale instance with `outcome_unknown` and does not submit again; the client must preserve the draft and tell the user acceptance is uncertain before a new manual submission. Legacy clients omitting these optional fields retain their original uncorrelated behavior.

Actual provider transcript captions now optionally carry an opaque `turn_id` derived from host service identity, provider epoch, role, and item/response identity. Caption deltas/finals for the same turn use the same ID; a new ID starts a new message even if a previous final was dropped. Existing role/text/final/sequence fields are unchanged. Empty final captions are reset signals and must close the displayed accumulation even when there is no text to append. Caption bodies remain speculative and droppable.

`memory.overview` is optional/null while unavailable or refreshing. A valid value has `summary` and one to four `sections`, each containing `title`, `summary`, `keywords` (up to five), and `refs` (`entry_id`, exact `version`). References must resolve to active entries in the current page. Summaries are derived display data, not new authoritative memories. Source changes, correction and forgetting invalidate them; clients show source excerpts when unavailable and must reject stale references. Snapshot revision also advances for asynchronous summary projection changes.

### Conversation-scoped desktop inputs

`personal.state.conversations` contains `selected_id`, nullable `voice_id`,
`unread_count`, `items` and the selected conversation's `messages`. Items expose
`id`, `kind` (`chat`, `topic`, `proactive`), `title`, `subject_key`, timestamps,
`generation` and `unread_count`. Messages expose `id`, `conversation_id`, `role`,
`text`, `created_at`, and optional `turn_id` / `reply_to`. Selection does not
transfer voice ownership. The fixed `chat:proactive` conversation receives proactive
reminders; only that conversation may speak them while it owns voice.

Authenticated `personal.command` methods:

- `conversations.create {title?}` and `conversations.select {id}`.
- `conversations.clear {id,expected_generation?}` clears only that conversation.
- `conversations.open_feed {feed_id,label?}` opens the stable topic idempotently;
  prepared source background remains untrusted and grants no execution authority.
- `conversations.voice {id,enabled}` explicitly starts or ends the single voice
  owner. Text is rejected in that conversation until voice ends; other conversations
  may run text concurrently. Dictation requires voice to be ended first.
- `conversations.read {id,through_message_id}` acknowledges only the displayed
  prefix. Repeating an old acknowledgement does not read later arrivals.

`input.text`, `input.audio`, and `input.dictation` accept `conversation_id`.
Correlated `input.text_result` acknowledges durable host admission; model completion
arrives through captions and updated state. A failed admitted response emits
`conversation.error {conversation_id,error}`. Same-conversation text turns execute
in order, with separate model history and causal state per conversation. Older
clients may omit the ID and retain the original single-service input behavior.

`caption`, `project.state`, and `executor.approval` may carry `conversation_id`.
The existing `project.confirmation_decision` and `executor.approval_decision` controls
accept that same ID. Clients must echo the ID from the approval frame, never infer
it from the currently selected conversation. An unknown scoped target is rejected
without falling back to the global service. Backend-instance and request-ID text
replay rules above still apply.
## Conversation presentation

The iOS UI starts in realtime mode. It offers text chat only when the host selects
cascaded media and advertises both `text_input` and `dictation`; losing that
capability returns the UI to realtime. Switching the UI mode does not reconfigure
the host pipeline. Entering text mode suspends live audio; leaving it cancels the
in-progress dictation while preserving the editable text draft.

The Swift client accumulates captions as an in-memory conversation list,
using `message_id` / final text to update a message rather than rendering each
partial caption as a new reply. This is client presentation, not a remote history
pagination API or a guarantee of persistence across app restart. Desktop memory
history pagination uses its separate local host interface. Approval decisions
continue through the existing connection-bound command contract.
