<a id="qr-配对-v1"></a>
<a id="对话呈现"></a>
# Nova 私有客户端协议 v1

<a id="nova-private-client-protocol-v1"></a>

远端入口为 `/client/v1`，通过 Tailscale Serve 使用 WSS。本机模拟器可在回环地址上使用 WS。该端点不开放摄像头或调试面板请求；桌面端 `/` 仍是独立的旧端点。

首个帧必须是文本，且在 3 秒内到达：

```json
{"type":"hello","token":"0123456789abcdef0123456789abcdef","protocol_version":1}
```

`token` 为 128 位随机数，小写十六进制，在本机预置并存入 iOS Keychain。示例仅用于 mock。不要把凭据放进 URL。鉴权先于任何状态同步和音频。鉴权失败以 4003 关闭；协议版本不支持以 4006 关闭；路径不支持以 4004 关闭；已有并发客户端以 4009 关闭。

鉴权成功返回如下（ID 均为示例）：

```json
{"type":"client.ready","protocol_version":1,"server_instance_id":"server-uuid","connection_id":"connection-uuid","input_audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1},"output_audio":{"encoding":"pcm_s16le","sample_rate":24000,"channels":1},"capabilities":["audio","captions","projects","executor"]}
```

音频格式与现有桌面/Qwen 管线一致：输入 16 kHz、输出 24 kHz、单声道有符号 PCM16 小端。iOS 设备采集通常为 48 kHz，客户端需自行重采样。不支持的格式必须拒绝，不能在采样率不匹配时静默播放。v1 不协商压缩音频。

## 媒体

<a id="media"></a>

上行二进制帧为 1–65536 字节，长度为偶数，内容是裸 PCM16。下行沿用 `desktop-wire.ts` 的 NOVA 封帧：4 个 ASCII 魔数字节、2 字节大端 JSON 头长度（上限 2048）、UTF-8 头部字节，随后接 PCM16。头部字段为 `utterance_id`、`generation_epoch`（正的安全整数）、`sequence`（非负安全整数）。读取长度前必须先确认可用字节数足够；非 ASCII 标识符要按协议解码；无法精确表示的整数要拒绝，而不是四舍五入。


下行文本复用现有的 `caption`、`playback.clear`、`playback.alert`、`playback.terminal`、`project.state`、`executor.state`、`executor.progress`、`executor.result`、`executor.results.reset`、`executor.approval` 与 `clock.ping` 载荷。其权威编码器是 `desktop-wire.ts`、`desktop-progress.ts`、`desktop-session.ts`。客户端不得把 terminal 当作音频已播放的证据。

## 控制与回执

<a id="controls-and-receipts"></a>

客户端控制是对现有桌面控制的一层封装：

```json
{"type":"client.command","request_id":"request-uuid","connection_id":"connection-uuid","payload":{"type":"project.confirmation_decision","proposal_id":"proposal-1","confirmed":true}}
```

允许的 `payload` 沿用桌面控制 schema：`speech.onset`，`playback.started/stopped/done/cleared`，项目与审批决策，时钟 pong 以及诊断/遥测。摄像头和任意工具执行会被拒绝。执行器确认决策可带可选的 `scope: "session"`，仅当当前宿主审批提供该选项时有效，UI 必须遵循 `allowed_decisions`。

```json
{"type":"client.command_result","request_id":"request-uuid","status":"applied"}
```

`applied` 是宿主回调给出的投递回执，**不代表**方案已被采纳或任务已执行；结果由宿主状态事件决定。`rejected` 表示重试冲突、容量不足或回调失败；`stale` 表示 connection ID 不匹配。每条连接最多记住 256 条控制，失败过的也算。相同 ID 加相同的规范化 payload 返回原回执；payload 改变后不能重新投递。容量用满时，服务端在发出回执后以 4008 关闭，客户端重连以获取新快照。控制按顺序串行处理；审批绝不跨连接边界自动重试。

文本控制上限 16 KiB；数字必须有限，整数须在 JS 安全范围内。输入缓冲上限 256 KiB / 128 条待处理消息，输出上限 256 KiB / 128 条待发送消息。任一超限即淘汰当前连接，但不会停掉 Runtime 图。重连后不回放音频积压。

断开连接时，清空本地音频和可操作的审批 UI。收到新的 ready 后使用其 connection ID。同一 server instance 会恢复内存中的项目/任务/结果状态；instance 不同说明服务已重启，不能视为任务被透明恢复。客户端挂断只是断开连接，不会取消 Codex 任务。

## 媒体选择（向后兼容的 v1 扩展）

<a id="media-selection-backward-compatible-v1-extension"></a>

新客户端在 `hello` 中带上 `media: {transports: ["host_pcm_v1"]}`。

`hello` 还可带 `language: "zh-CN" | "en"`。宿主在鉴权之后、接受输入之前校验该枚举值，用它为本连接选择翻译后的 AI 系统指令（包括任务旁白）。它不翻译用户消息，不强制回复语言，也不改 ASR/TTS 模型或音色。省略该字段则回到宿主配置的默认值（`PROMPT_LANGUAGE`，否则为 `zh-CN`），而不是继承上一个客户端的选择。取值不支持时拒绝连接。relay 和两种 AOQ 模式都支持该字段，旧宿主可能忽略它。客户端修改语言后需重连才能生效。

鉴权后的宿主选择其配置的管线，并在 `client.ready` 中返回：

```json
{"media":{"transport":"host_pcm_v1","path":"relay","audio_owner":"client","pipeline":"integrated"}}
```

`pipeline` 取 `integrated` 或 `cascaded`，来源于构造生产 provider 时使用的同一份已校验配置，与媒体路径无关。Qwen integrated 与支持的火山引擎 cascaded 配置共用同一套传输、审批 UI、连接身份和 PCM 格式。任何 provider 凭据、URL、原始事件或 SDK 对象都不会穿过这份契约。

不提供 offer 等同于原始 v1 relay。显式 offer 必须包含 1–8 个有界传输名且含 `host_pcm_v1`，否则服务端在 **Runtime 准入之前**以 4006 关闭。同时提供 AOQ 和 relay 的客户端会收到明确的 relay 选择；只提供 AOQ 会被拒绝。offer 中的未知字段也会被拒绝。新版 iOS 客户端要能接受不带 `media` 的旧宿主，但在麦克风启动前就要拒绝任何显式不支持的 path、owner、pipeline 或畸形描述符。每条连接只有一条媒体路径，切换需断开重连。`connection_id` 与已有的 playback/provider generation 各自保持独立归属；该扩展不会在 `client.ready` 中伪造 provider 会话身份。

direct 模式和 provider 控制消息刻意未开放：把 provider 原始事件当作 `client.command` 接收，或返回 AOQ token，都会破坏现有的授权与播放契约。

未配置或测试用传输会省略 `media`，而不是编造生产管线。已配置的描述符须严格校验，并在分配监听器前复制；多余字段（包括凭据）都会被拒绝。

## 二维码配对 v1

<a id="qr-pairing-v1"></a>

所有媒体模式共用配对流程，现有的 `hello` 和媒体协议保持不变。

- 二维码载荷：`{type:"nova.pair",version:1,server:"wss://host/client/v1",code:<32 位小写十六进制>}`。仅允许 WSS，拒绝带 userinfo/query/fragment 或路径无关的地址。客户端在交换前先展示目标地址。新邀请不再带 `expires_at`；更新过的客户端扫描旧服务端邀请时仍要校验它。
- `/client/pair`：发送一个文本帧 `{type:"pair.redeem",code,device_name}`。成功返回 `{type:"pair.ready",token,device_id}`；失败返回 `{type:"pair.error",message}`。一个 socket 处理一次响应后关闭。这里不接受麦克风、不分配模型，也不放行宿主控制。
- `/client/pair-admin`：一个文本请求，用主 `token` 鉴权。`pair.create` 接收 `server`，返回二维码载荷；`pair.list` 返回 `{type:"pair.devices",devices:[{id,name,created_at}],pairing_active}`。可选的 `code` 用于检查某个邀请是否仍有效。`pair.revoke` 接收 `device_id`；`pair.cancel` 接收 `code`；两者都返回当前设备列表。设备 token 不能调用这些操作。
- 每个进程同时只有一个活跃的 128 位随机邀请，没有基于时间的过期，设备持久化注册完成后同步消费。新邀请会替换旧邀请。并发配对/管理 socket 上限 8 个，请求上限 4096 字节，socket 生命周期 5 秒，每宿主每分钟 60 次兑换尝试，已注册设备上限 32 台。
- 每次成功交换签发一个独立的 128 位设备 token。私有存储只保存 token 哈希，并绑定到主 token。relay 和两种 AOQ 模式都在各自的正常 `hello` 中接受这些 token。撤销设备时先持久化删除，再以 4003 关闭该设备的活动 socket。
- 配对请求和凭据不得写日志、不得放进 URL 参数、不得自动重试。如果投递或本地 Keychain 持久化失败，就重新生成邀请并删除那个孤立设备条目。网络可达性和 TLS 仍是前提条件。

### 级联可编辑输入

级联主机的 `client.ready.capabilities` 会声明 `text_input`、`dictation`。以下 payload 复用绑定 connection_id、request_id 的 `client.command` 与去重回执：

- `input.text`：`text` 为非空、最长 4000 个 UTF-16 单元的用户文本。
- `input.dictation`：`id` 为草稿 ID，`action` 取 start/finish/cancel。start 后二进制 PCM 仅进入有界草稿缓冲（16 kHz PCM16，最多 60 秒）；finish 仅调用当前级联 ASR，30 秒超时；cancel 或断线都会取消识别。
- `input.audio`：结束草稿输入模式，显式恢复连续语音；草稿完成后的迟到音频不会自动进入模型。

识别结果返回 `input.transcription`，含匹配的 `id` 和 `text`，失败时只返回 `error: recognition_failed`。草稿不算用户轮次，不触发 LLM 或工具；客户端必须显式发送编辑后的 `input.text`。

### 个人主机与可靠的文本确认

已鉴权的桌面 socket 可直接接受 `personal.command`。远程客户端把同一 payload 包进 `client.command`；外层的 `client.command_result` 只确认控制处理器已收到，`personal.result` 才报告该领域操作的结果：

```json
{"type":"personal.command","request_id":"request-uuid","method":"state","params":{}}
{"type":"personal.result","request_id":"request-uuid","ok":true}
```

方法包括 `state`、`feed.action`、`memory.list`、`memory.correct`、`memory.forget`、`discovery.configure`，以及 `sources.add/pause/resume/disconnect/delete/sync`。修改记忆需带 `{id,expected_version}`；纠正操作还需带 `content`。资讯动作使用 `{id,action,snooze_until?}`，`action` 取 `open`、`act`、`snooze`、`dismiss`、`expand_evidence`、`presented`、`notified`。只有显式的 `act` 请求会进入常规的用户授权路径。发现配置接受 `{enabled?,interval_minutes?}`（5–1440 分钟，默认 30）。目录准入需要用户明确同意；客户端不能自行选择用户范围或存储路径。

宿主发送的 `personal.state` 包含 `{revision,feed,memory:{entries,cursor,overview?},sources,capabilities,settings}`。应将其视为权威快照；能力布尔值决定当前可执行的操作。领域操作失败时返回 `ok:false,error`。请求 ID 会在一份有界的持久回执账本中去重；私密的记忆/快照内容不会保留在该账本里，重放这类回执时会带上 `reload_required:true`。应改用新的请求 ID 重新请求 `state` 或 `memory.list`，不要把缺失的 `data` 当作完整结果。

文本输入仍兼容 `{type:"input.text",text}`。新客户端应使用带关联信息的形式：

```json
{"type":"desktop.capabilities","capabilities":["text_input","dictation"],"input_instance_id":"host-uuid"}
{"type":"input.text","request_id":"text-uuid","input_instance_id":"host-uuid","text":"Please review my notes"}
{"type":"input.text_result","request_id":"text-uuid","ok":true}
```

`input.text_result` 是必须送达、不可丢弃的回执。`ok:true` 只表示宿主已把内容提交给当前 provider 并得到结果，不代表任务已经完成。字幕（即使最终文本与用户输入完全一致）从不作为输入确认。被拒绝的提交返回 `ok:false,error`，错误码包括 `submission_failed`、`request_id_conflict`、`request_capacity` 或 `outcome_unknown`。

桥接层在其运行期内最多保留 256 条文本请求回执，且不会淘汰已接受的请求。相同的请求 ID/文本重试会复用原有操作和回执，包括跨渲染进程重连的情况。找回丢失的回执时要保留原始的 `request_id` 和 `input_instance_id`。若后端实例已更换，会以 `outcome_unknown` 拒绝这个过期实例，且不会重新提交；客户端必须保留草稿，并在允许用户再次手动提交前提示确认结果未知。省略这些可选字段的旧版客户端保留原有的非关联行为。

实际 provider 转写字幕现在可以选择携带一个不透明的 `turn_id`，由宿主服务身份、provider epoch、角色以及 item/response 身份共同派生。同一轮次的字幕增量/终稿使用相同 ID；即使前一条终稿被丢弃，新 ID 也会开启新的一条消息。已有的 role/text/final/sequence 字段不变。空的终稿字幕是重置信号，即使没有文本可追加，也必须结束当前正在显示的累积内容。字幕内容始终是推测性的，可被丢弃。

`memory.overview` 在不可用或刷新期间是可选的、可为 `null`。有效值包含 `summary` 以及一到四个 `sections`，每个 section 含 `title`、`summary`、`keywords`（最多五个）和 `refs`（`entry_id`、精确的 `version`）。引用必须能解析到当前页面中的有效条目。摘要是派生的展示数据，不是新的权威记忆。来源变化、纠正或忘记会使其失效；客户端应在摘要不可用时展示来源原文，并拒绝过期的引用。异步的摘要投影变化也会推进快照的 revision。

### 会话范围内的桌面输入

`personal.state.conversations` 包含 `selected_id`、可为 `null` 的 `voice_id`、`unread_count`、`items`，以及当前选中会话的 `messages`。`items` 中每项含 `id`、`kind`（`chat`、`topic`、`proactive`）、`title`、`subject_key`、时间戳、`generation` 和 `unread_count`。`messages` 中每条含 `id`、`conversation_id`、`role`、`text`、`created_at`，以及可选的 `turn_id` / `reply_to`。切换选中会话不会转移语音归属。固定的 `chat:proactive` 会话接收主动提醒；只有在该会话拥有语音归属时才能播报这些提醒。

已鉴权的 `personal.command` 方法：

- `conversations.create {title?}` 与 `conversations.select {id}`。
- `conversations.clear {id,expected_generation?}` 只清空指定会话。
- `conversations.open_feed {feed_id,label?}` 幂等地打开固定话题；已准备好的来源背景信息仍不可信，不授予任何执行权限。
- `conversations.voice {id,enabled}` 显式开始或结束这个唯一的语音归属方。该会话在语音结束前会拒绝文本输入；其他会话可以并行运行文本。听写前必须先结束语音。
- `conversations.read {id,through_message_id}` 只确认已显示的前缀部分。重复一个旧的确认不会读取之后到达的内容。

`input.text`、`input.audio` 和 `input.dictation` 都接受 `conversation_id`。带关联信息的 `input.text_result` 只确认宿主已持久接受该输入；模型的完成结果通过字幕和更新后的状态送达。已接受但处理失败的响应会发出 `conversation.error {conversation_id,error}`。同一会话内的文本轮次按顺序执行，各会话拥有独立的模型历史与因果状态。旧版客户端可以省略该 ID，保留原有的单一服务输入行为。

`caption`、`project.state` 和 `executor.approval` 都可以携带 `conversation_id`。现有的 `project.confirmation_decision` 与 `executor.approval_decision` 控制消息接受同一个 ID。客户端必须直接回传审批帧中的 ID，绝不能从当前选中的会话推断。未知的范围目标会被拒绝，而不会回退到全局服务。上文的后端实例与请求 ID 文本重放规则同样适用。

## 会话呈现

<a id="conversation-presentation"></a>

iOS UI 默认处于实时模式。只有当宿主选中级联媒体并同时声明 `text_input` 和 `dictation` 时，才提供文字聊天；该能力一旦消失，UI 回到实时模式。切换 UI 模式不会重新配置宿主管线。进入文字模式会暂停实时音频；离开时会取消进行中的听写，同时保留可编辑的文字草稿。

Swift 客户端把字幕累积为内存中的会话列表，按 `message_id`／最终文本更新同一条消息，而不是把每段 partial caption 渲染成新回复。这属于客户端呈现层，不是远端历史分页 API，也不保证跨应用重启持久化。桌面端的内存历史分页走其本地的宿主接口。审批决策仍通过现有的连接绑定命令契约完成。


## 移动端 personal 工作台（显式协商）

手机在 v1 hello 中声明 `capabilities: ["personal"]`，宿主才在
`client.ready.capabilities` 中返回 `personal`。未声明的旧客户端保留原有能力与
16 KiB JSON 限制。hello 和上行命令仍限制为 16 KiB；协商后的
**personal.state / personal.result 下行帧**按 UTF-8 字节计算，最多 1 MiB。
其他 JSON 帧保持原有限制。

移动快照只保留 `type`、`revision`、`reload_required`、`life`、`tasks`、
`conversations`、`feed`、`memory`、`pending_approvals`、`pending_confirmations`
、只读 `news` 投影、下文所述的精简 `workbench_context` 与 `profile_preparation`
投影，以及任务/记忆能力。sources、feishu、connectors 等桌面专用投影不下发；命令结果中
嵌套的状态也使用同一投影。

状态变化在固定的 250 ms 窗口内合并，只发送最新快照。断开连接会清除待发送状态。
超限状态降级为 `{"type":"personal.state","revision":9,"reload_required":true}`。
超限结果保留 request ID、`ok` 与错误结果，去掉 data 并设置 `reload_required:true`。
客户端保留最后一份完整离线缓存，重新读取一次 `state`；读取结果仍然超限时停止自动
重试，避免循环。降级标记不能推进完整状态的 revision，也不能作为重放写命令的理由。
同一 server instance 只接受更高的 revision；宿主重启后的首份状态允许重新计数。

个人命令沿用 `client.command` 封装。手机传输层使用
`client_id:"remote:master", can_takeover:false`，配对凭据仍按设备分别保存和撤销。
移动命令允许列表覆盖 life、feed、memory、conversation 和 task 工作台操作，不开放
数据源、连接器和飞书管理。执行与审批继续使用宿主原有授权和乐观版本检查。
文字、听写和语音输入携带 `conversation_id`；文字还携带 bridge 的
`input_instance_id` 和幂等 request ID。投递回执不代表文字提交成功，客户端必须等待
`input.text_result`。

Mac 内置手机端点运行在桌面 runtime 内，与桌面共用同一个 PersonalAgentHost。
两端各有独立队列、听写状态和断线边界。同一时刻只有一个音频所有者接收输出音频并
提交 PCM/播放 ACK；非所有者的断开不能清除另一端的播放。网络只走 Tailscale Serve，
第二台手机仍以 4009 拒绝。显式配置的外部手机服务连接另一台宿主，不保证与本地
workbench 同步。Windows 配对留到 M6。

`tests/fixtures/client-protocol/v1/vectors.json` 的首个音频向量新增可选的
`personal_protocol` 元数据，包含协商和超限重载示例。旧音频向量读取器忽略该字段。

Mac 内置共享端点对未声明 personal 的客户端也执行手机命令允许列表和远程身份限制。
旧客户端不接收 personal 帧；文字和 PCM 对应宿主当前选择的会话，语音被另一端占用时
以 4009 拒绝连接。桌面离开悬浮球时清理输入与播放，并释放隐式音频占用。

对已协商 personal 的客户端，认证后的协议错误以 1002 关闭；4003 表示认证拒绝或
明确撤销设备，避免坏帧或宿主初始化错误触发手机删除配对凭据。旧客户端关闭码保持原行为。

移动端 `news` 仅含 `enabled`、`refreshing`、`items`、`saved`。文章只保留 id、source_id、title、summary、url、published_at、read、saved，内置来源另附 `source_name`；不下发数据源配置和排序内部信息。手机暂不开放资讯修改命令。

移动端 `workbench_context` 含 `status`、`recap {text, projects[{name, line}]}` 和 `cards[{id, tab, title, body, why, next, source_count}]`。移动端 `profile_preparation` 含 `status` 和 `draft {about, work[{title, text}]}`（或 null）。不下发来源原文、标签和引用，只提供支撑来源的条数。手机可以使用 `context.adopt` 和 `context.dismiss`。
