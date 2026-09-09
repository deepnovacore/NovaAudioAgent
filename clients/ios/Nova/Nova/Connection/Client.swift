import AVFoundation
import SwiftUI
import UIKit

struct ApprovalCard: Identifiable {
    let id: String
    let executor: String?
    let project: String
    let title: String
    let detail: String
    let decisions: [String]
    let deadline: Date?
    let busy: Bool
    func actionable(at date: Date) -> Bool { !busy && deadline.map { $0 > date } == true }
}
private final class SocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    var closed: ((URLSessionWebSocketTask, Int) -> Void)?
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        closed?(webSocketTask, closeCode.rawValue)
    }
}

@MainActor final class Client: ObservableObject {
    @Published var inputDraft = ""
    @Published private(set) var editableInput = false
    @Published private(set) var pipeline: String?
    @Published private(set) var dictationRecording = false
    @Published private(set) var dictationTranscribing = false
    @Published private(set) var textSending = false
    @Published private(set) var inputNotice = ""
    private var dictationHolding = false
    private var dictationID: String?
    private var dictationBase = ""
    private var dictationTask: Task<Void, Never>?
    private var dictationCommands = Set<String>()
    private var textRequest: (id: String, text: String)?
    private var textTimeout: Task<Void, Never>?

    func beginDictation() {
        guard editableInput, connected, !voice, !voiceStarting, !dictationHolding, !dictationTranscribing, !textSending else { return }
        dictationHolding = true
        let current = generation, id = UUID().uuidString
        dictationID = id
        Task {
        let granted = await AVAudioApplication.requestRecordPermission()
        guard dictationHolding, dictationID == id, current == generation, connected, UIApplication.shared.applicationState == .active else { return }
        guard granted else { dictationHolding = false; inputNotice = "请在系统设置中允许麦克风访问"; return }
        dictationBase = inputDraft; inputNotice = ""
        if let request = command(["type": "input.dictation", "id": id, "action": "start"]) { dictationCommands.insert(request) }
        do {
            audio.stop(); dictationRecording = true
            try audio.start(threshold: speechThreshold)
            dictationTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(45))
                guard !Task.isCancelled else { return }; self?.finishDictation()
            }
        } catch { cancelDictation(); inputNotice = "无法启动录音，请重试" }
        }
    }
    func finishDictation() {
        dictationHolding = false
        guard dictationRecording, let id = dictationID else { cancelDictation(); return }
        dictationRecording = false; audio.stop(); dictationTask?.cancel()
        dictationTranscribing = true
        if let request = command(["type": "input.dictation", "id": id, "action": "finish"]) { dictationCommands.insert(request) }
        dictationTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(35))
            guard !Task.isCancelled, let self, self.dictationID == id else { return }
            self.cancelDictation(); self.inputNotice = "识别超时，请重试。原草稿已保留。"
        }
    }
    func cancelDictation() {
        if let id = dictationID { command(["type": "input.dictation", "id": id, "action": "cancel"]) }
        if dictationRecording { audio.stop() }
        dictationHolding = false; dictationRecording = false; dictationTranscribing = false
        dictationTask?.cancel(); dictationTask = nil; dictationID = nil; dictationCommands.removeAll()
    }
    func sendDraft() {
        let text = inputDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard editableInput, connected, !voice, !voiceStarting, !dictationHolding, !dictationTranscribing, !textSending,
              !text.isEmpty, text.utf16.count <= 4000 else { return }
        do { try audio.start(threshold: speechThreshold, capture: false) }
        catch { inputNotice = "无法启动语音播放，请重试"; return }
        guard let id = command(["type": "input.text", "text": text]) else { return }
        textSending = true; textRequest = (id, text); inputNotice = ""
        textTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.textRequest?.id == id else { return }
            self.textSending = false; self.textRequest = nil
            self.inputNotice = "未收到发送确认，请先查看回复，避免重复发送。草稿已保留。"
        }
    }

    @Published var server = UserDefaults.standard.string(forKey: "nova.server") ?? ""
    @Published var token = ""
    @Published var debugLocalhost = false
    @Published var mediaPreference = UserDefaults.standard.string(forKey: "nova.media") ?? "auto" {
        didSet { UserDefaults.standard.set(mediaPreference, forKey: "nova.media") }
    }
    @Published private(set) var aoqChat = false
    @Published private(set) var aoqRuntime = false
    @Published private(set) var voiceStarting = false
    static var aoqAvailable: Bool { AOQAudio.available }
    private var aoq: AOQAudio?
    private var aoqRequest: String?
    private var aoqBridge: AOQRuntimeBridge?
    private var hostHeartbeat: Task<Void, Never>?
    private var offeredTransports: [String] = []
    @Published var status = "尚未连接"
    @Published var connected = false
    @Published var connecting = false
    @Published var voice = false
    @Published var inputLevel: Float = 0
    @Published var muted = false
    @Published var speaker = false
    @Published var speechThreshold: Float = 0.045
    @Published var captions: [String: String] = [:]
    @Published var project = "No project"
    @Published var taskStates: [String: String] = [:]
    @Published var results: [String: String] = [:]
    @Published var approvals: [ApprovalCard] = []
    @Published var submitted = Set<String>()
    @Published var commandStatus = ""
    private var captionSequence = -1
    @Published private(set) var pairing = false
    private var pairingTask: Task<Void, Never>?
    private var pairingSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiveTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var readyWatchdog: Task<Void, Never>?
    private var sendWatchdog: Task<Void, Never>?
    @Published private(set) var connectionRevision = UUID()
    private var generation = UUID()
    private var connection: String?
    private var instance: UUID?
    private var recovery = ConnectionRecovery()
    private var requested = false
    private var endpoint: URL?
    private var queue: [(URLSessionWebSocketTask.Message, Int)] = []
    private var queuedBytes = 0
    private var audioEnqueued = 0
    private var audioSent = 0
    private var approvalRequests: [String: String] = [:]
    private let audio = VoiceAudio()

    init() {
        loadCredential()
        audio.onLevel = { [weak self] level in if !UIAccessibility.isReduceMotionEnabled { self?.inputLevel = level } }
        audio.onPCM = { [weak self] data in guard let self, self.voice || self.dictationRecording else { return }; self.enqueue(.data(data), bytes: data.count) }
        audio.onControl = { [weak self] payload in guard let self else { return }; if payload["type"] as? String == "speech.onset" && !self.voice { return }; self.command(payload) }
        audio.onStopped = { [weak self] reason in self?.end(); self?.status = reason }
    }
    func loadCredential() {
        if let url = try? Wire.endpoint(server, debugLocalhost: debugLocalhost) { token = Credentials.read(server: url.absoluteString) }
    }
    func connectFeishu(_ credential: EnterpriseSSO.Credential) {
        end()
        server = credential.server; token = credential.token
        connect()
    }
    func connect() {
        end()
        do {
            let url = try Wire.endpoint(server, debugLocalhost: debugLocalhost)
            guard token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { throw WireError("连接密钥应为 32 位小写十六进制字符。") }
            try Credentials.save(token, server: url.absoluteString)
            endpoint = url
            UserDefaults.standard.set(url.absoluteString, forKey: "nova.server")
            requested = true; recovery = ConnectionRecovery(); open()
        } catch { status = error.localizedDescription }
    }
    func pair(_ invitation: PairingCode) {
        end()
        guard invitation.expiresAt > Date() else { status = "二维码已过期，请在 Mac 上重新生成。"; return }
        let id = generation
        pairing = true; connecting = true; status = "正在配对主机"
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: config)
        pairingSession = session
        let socket = session.webSocketTask(with: invitation.endpoint)
        socket.maximumMessageSize = 4096
        socket.resume()
        pairingTask = Task { [weak self] in
            let timeout = Task {
                try? await Task.sleep(for: .seconds(10))
                if !Task.isCancelled { socket.cancel(with: .goingAway, reason: nil) }
            }
            defer { timeout.cancel(); session.invalidateAndCancel() }
            do {
                let request: [String: Any] = ["type": "pair.redeem", "code": invitation.code,
                                             "device_name": String(UIDevice.current.name.prefix(80))]
                try await socket.send(.string(String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self)))
                let message = try await socket.receive()
                guard let self, self.generation == id, !Task.isCancelled else { return }
                guard UIApplication.shared.applicationState == .active else {
                    self.end(); self.status = "配对已取消，请回到 App 后重新扫码。"; return
                }
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: throw WireError("配对响应无效")
                }
                let reply = try Wire.json(data, limit: 4096)
                guard reply["type"] as? String == "pair.ready", let credential = reply["token"] as? String,
                      credential.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
                      let deviceID = reply["device_id"] as? String, UUID(uuidString: deviceID) != nil else {
                    throw WireError("配对失败：二维码可能已过期或已使用，请在 Mac 上重新生成。")
                }
                try Credentials.save(credential, server: invitation.server.absoluteString)
                self.server = invitation.server.absoluteString; self.token = credential
                self.pairingTask = nil
                self.connect()
            } catch {
                guard let self, self.generation == id, !Task.isCancelled else { return }
                self.pairingTask = nil; self.end()
                self.status = "配对失败，请检查网络，并在 Mac 上重新生成二维码后重试。"
            }
        }
    }
    private func open() {
        guard requested, let endpoint else { return }
        let id = UUID(); generation = id
        let aoqTransports = ["qwen_aoq_runtime_v1", "qwen_aoq_chat_v1"]
        offeredTransports = mediaPreference == "aoq" ? (AOQAudio.available ? aoqTransports : [])
            : mediaPreference == "relay" || !AOQAudio.available ? ["host_pcm_v1"] : ["host_pcm_v1"] + aoqTransports
        guard !offeredTransports.isEmpty else { requested = false; status = "此构建未包含 AOQ SDK"; return }
        connecting = true; status = "正在连接"
        let delegate = SocketDelegate()
        delegate.closed = { [weak self] task, code in
            Task { @MainActor in
                guard let self, self.generation == id, self.socket === task else { return }
                self.failed(code: code, reason: "尚未连接")
            }
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        self.session = session
        let socket = session.webSocketTask(with: endpoint)
        socket.maximumMessageSize = max(Wire.maxJSON, max(6 + Wire.maxHeader + Wire.maxPCM, AOQRuntimeBridge.maxEnvelope))
        self.socket = socket; socket.resume()
        readyWatchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, let self, self.generation == id, self.connection == nil else { return }
            self.failed(code: 0, reason: "连接握手超时，请检查 Mac 地址")
        }
        receiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                let hello: [String: Any] = ["type": "hello", "token": self.token, "protocol_version": 1, "media": ["transports": self.offeredTransports]]
                let data = try JSONSerialization.data(withJSONObject: hello)
                try await socket.send(.string(String(decoding: data, as: UTF8.self)))
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard self.generation == id else { return }
                    try self.receive(message)
                }
            } catch {
                // URLSession may deliver didClose just after receive throws. Let its explicit
                // unauthorized/busy/version code win over a generic network error.
                try? await Task.sleep(for: .milliseconds(100))
                guard self.generation == id, !Task.isCancelled else { return }
                self.failed(code: Wire.receiveFailureCode(error, ready: self.connection != nil, serverCode: socket.closeCode.rawValue),
                            reason: error is WireError ? error.localizedDescription : "连接中断，正在尝试恢复")
            }
        }
    }
    private func receive(_ message: URLSessionWebSocketTask.Message) throws {
        if connection == nil {
            guard case .string(let text) = message else { throw WireError("Expected client.ready before media") }
            let ready = try Wire.ready(Wire.json(Data(text.utf8)),
                                       allowAOQ: offeredTransports.contains("qwen_aoq_chat_v1"),
                                       allowAOQRuntime: offeredTransports.contains("qwen_aoq_runtime_v1"))
            guard ready.aoqChat || offeredTransports.contains("host_pcm_v1") else { throw WireError("主机当前未启用 AOQ，请切换服务端模式") }
            pipeline = ready.pipeline; editableInput = ready.editableInput
            aoqChat = ready.aoqChat
            aoqRuntime = ready.aoqRuntime
            let restarted = instance != nil && instance != ready.instance
            instance = ready.instance; connection = ready.connection
            readyWatchdog?.cancel(); recovery.markReady(atMS: Wire.renderMS)
            connected = true; connecting = false
            status = restarted ? "Mac 服务已重启，旧任务不会重复提交" : "已连接"
            if aoqChat {
                if aoqRuntime { aoqBridge = AOQRuntimeBridge(connection: ready.connection) }
                status = "AOQ"; monitorHost(id: generation)
            }
            return
        }
        if aoqChat {
            guard case .string(let text) = message else { throw WireError("AOQ 控制连接不接受音频") }
            let value = try Wire.json(Data(text.utf8), limit: max(Wire.maxJSON, aoqRuntime ? AOQRuntimeBridge.maxEnvelope : Wire.maxJSON))
            switch value["type"] as? String {
            case "aoq.credentials":
                guard voiceStarting, let request = aoqRequest, value["request_id"] as? String == request,
                      value["connection_id"] as? String == connection,
                      !aoqRuntime || (value["mode"] as? String == "runtime" && value["session"] == nil) else { throw WireError("过期的 AOQ 连接凭证") }
                aoqRequest = nil
                let id = generation
                let adapter = AOQAudio(); aoq = adapter
                adapter.onCaption = { [weak self] role, text in guard let self, self.generation == id else { return }; self.captions[role] = text }
                adapter.onLevel = { [weak self] level in guard let self, self.generation == id else { return }; self.inputLevel = self.muted ? 0 : level }
                adapter.onReady = { [weak self] in guard let self, self.generation == id else { return }; self.voiceStarting = false; self.voice = true; self.status = "正在聆听 · AOQ" }
                adapter.onFailure = { [weak self] reason in guard let self, self.generation == id else { return }; self.end(); self.status = reason }
                adapter.onEvent = { [weak self] event in
                    guard let self, self.generation == id, var bridge = self.aoqBridge else { return }
                    do {
                        if let envelope = try bridge.envelope(event) {
                            self.aoqBridge = bridge
                            let data = try JSONSerialization.data(withJSONObject: envelope)
                            self.enqueue(.string(String(decoding: data, as: UTF8.self)), bytes: data.count)
                        }
                    } catch { self.failed(code: 0, reason: "AOQ 返回了不兼容的数据") }
                }
                try adapter.start(value, runtime: aoqRuntime)
            case "aoq.command":
                guard aoqRuntime, var bridge = aoqBridge, let aoq else { throw WireError("AOQ Runtime 尚未启动") }
                let event = try bridge.command(value); aoqBridge = bridge
                try aoq.command(event)
            case "aoq.error": end(); status = "AOQ 暂不可用，请检查主机配置后重连"
            default:
                guard aoqRuntime else { throw WireError("AOQ 返回不兼容的控制消息") }
                try receiveHost(value)
            }
            return
        }
        switch message {
        case .data(let data): try audio.receive(Wire.audio(data))
        case .string(let text):
            try receiveHost(Wire.json(Data(text.utf8), limit: Wire.maxJSON))
        @unknown default: throw WireError("Unsupported WebSocket message")
        }
    }
    private func receiveHost(_ value: [String: Any]) throws {
            switch value["type"] as? String {
            case "playback.clear":
                if aoqRuntime { try aoq?.interruptPlayback() } else { audio.clear(try Wire.identity(value)) }
            case "playback.terminal":
                if !aoqRuntime { audio.terminal(try Wire.identity(value)) }
            case "playback.alert": status = "播放暂时中断"
            case "clock.ping":
                command(["type": "clock.pong", "ping_id": try Wire.identifier(value["ping_id"]), "t_render_ms": Wire.renderMS])
            case "caption":
                let sequence = try Wire.integer(value["sequence"])
                if sequence > captionSequence, let text = value["text"] as? String, let role = value["role"] as? String, ["user", "assistant"].contains(role) {
                    captionSequence = sequence; captions[role] = text
                }
            case "project.state":
                project = [value["workspace_display_name"], value["session_title"]].compactMap { $0 as? String }.joined(separator: " · ")
                approvals.removeAll { $0.executor == nil }
                if value["pending_confirmation"] as? Bool == true,
                   let id = value["pending_confirmation_id"] as? String, !id.isEmpty, id.unicodeScalars.count <= 128 {
                    approvals.append(ApprovalCard(id: id, executor: nil,
                        project: value["pending_workspace_display_name"] as? String ?? project,
                        title: value["pending_session_title"] as? String ?? "确认项目",
                        detail: value["pending_action"] as? String ?? "请确认这个项目",
                        decisions: ["accept", "decline"], deadline: deadline(value["pending_expires_in_seconds"]),
                        busy: value["pending_confirmation_busy"] as? Bool != false))
                }
            case "executor.approval":
                let executor = try Wire.identifier(value["executor"])
                approvals.removeAll { $0.executor == executor }
                if value["pending_approval"] as? Bool == true,
                   let id = value["pending_approval_id"] as? String, !id.isEmpty, id.unicodeScalars.count <= 128,
                   let detail = value["local_detail"] as? [String: Any] {
                    let work = value["work"] as? [String: Any] ?? [:]
                    let allowed = value["allowed_decisions"] as? [String] ?? ["accept", "decline"]
                    approvals.append(ApprovalCard(id: id, executor: executor, project: work["project"] as? String ?? project,
                        title: work["title"] as? String ?? executor,
                        detail: ([value["operation_summary"] as? String] + Self.detailLines(detail)).compactMap { $0 }.joined(separator: "\n"),
                        decisions: allowed.filter { ["accept", "acceptForSession", "decline"].contains($0) },
                        deadline: deadline(value["expires_in_seconds"]), busy: value["pending_approval_busy"] as? Bool != false))
                }
            case "executor.state":
                let name = try Wire.identifier(value["executor"])
                taskStates[name] = value["state"] as? String ?? "Unknown"
            case "executor.progress":
                let id = try Wire.identifier(value["delegate_id"])
                taskStates[id] = [value["phase"], value["summary"]].compactMap { $0 as? String }.joined(separator: " · ")
            case "executor.results.reset": results.removeAll()
            case "executor.result":
                let id = try Wire.identifier(value["work_id"])
                if let result = value["result"] as? [String: Any] {
                    results[id] = [result["project"], result["title"], result["outcome"], result["summary"]].compactMap { $0 as? String }.joined(separator: " · ")
                } else { results.removeValue(forKey: id) }
            case "input.transcription":
                guard let id = value["id"] as? String, id == dictationID, dictationTranscribing else { return }
                if let text = value["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 4000 {
                    inputDraft = dictationBase.isEmpty ? text : dictationBase + "\n" + text
                    inputNotice = "可编辑后发送"
                } else { inputNotice = "未能识别语音，请重试。原草稿已保留。" }
                cancelDictation()
            case "client.command_result":
                if let id = value["request_id"] as? String {
                    if dictationCommands.remove(id) != nil, value["status"] as? String != "applied" {
                        cancelDictation(); inputNotice = "主机未接受语音识别，请重试"
                    }
                    if let request = textRequest, request.id == id {
                        textTimeout?.cancel(); textRequest = nil; textSending = false
                        if value["status"] as? String == "applied" {
                            if inputDraft.trimmingCharacters(in: .whitespacesAndNewlines) == request.text { inputDraft = "" }
                        } else { inputNotice = "消息未被接受，草稿已保留" }
                    }
                }
                if let id = value["request_id"] as? String, approvalRequests.removeValue(forKey: id) != nil {
                    let result = value["status"] as? String ?? "unknown"
                    commandStatus = result == "applied" ? "已发送，等待 Mac 确认" : (result == "rejected" ? "Mac 未接受这次操作" : result == "stale" ? "操作已过期，请等待新的确认" : "Mac 返回：\(result)")
                }
            default: break // Unknown display events have no authority.
            }
            // UI history is intentionally bounded; the runtime owns durable task state.
            if taskStates.count > 64 { taskStates.removeValue(forKey: taskStates.keys.sorted().first!) }
            if results.count > 32 { results.removeValue(forKey: results.keys.sorted().first!) }
            if approvals.count > 16 { throw WireError("Too many approval cards") }
    }
    private func deadline(_ value: Any?) -> Date? {
        guard let seconds = value as? Double, seconds.isFinite, seconds >= 0, seconds <= 3600 else { return nil }
        return Date().addingTimeInterval(seconds)
    }
    private static func detailLines(_ detail: [String: Any]) -> [String?] {
        var lines = [detail["command"] as? String, detail["cwd"] as? String, detail["scope"] as? String]
        for change in detail["changes"] as? [[String: Any]] ?? [] {
            lines.append([change["change"], change["path"], change["move_path"]].compactMap { $0 as? String }.joined(separator: " → "))
        }
        return lines
    }
    func decide(_ card: ApprovalCard, decision: String) {
        guard connected, card.actionable(at: Date()), !submitted.contains(card.id), card.decisions.contains(decision),
              approvals.contains(where: { $0.id == card.id && $0.executor == card.executor }) else { return }
        var payload: [String: Any]
        if let executor = card.executor {
            payload = ["type": "executor.approval_decision", "executor": executor, "approval_id": card.id, "approved": decision != "decline"]
            if decision == "acceptForSession" { payload["scope"] = "session" }
        } else { payload = ["type": "project.confirmation_decision", "proposal_id": card.id, "confirmed": decision == "accept"] }
        submitted.insert(card.id)
        commandStatus = "正在提交你的决定…"
        command(payload, approval: card.id)
    }
    @discardableResult
    private func command(_ payload: [String: Any], approval: String? = nil) -> String? {
        guard let connection, connected else { return nil }
        do {
            let id = UUID().uuidString
            let value: [String: Any] = ["type": "client.command", "request_id": id, "connection_id": connection, "payload": payload]
            let data = try JSONSerialization.data(withJSONObject: value)
            if let approval { approvalRequests[id] = approval }
            enqueue(.string(String(decoding: data, as: UTF8.self)), bytes: data.count)
            return id
        } catch { failed(code: 0, reason: "暂时无法发送操作"); return nil }
    }
    private func enqueue(_ message: URLSessionWebSocketTask.Message, bytes: Int) {
        guard connected, let socket else { return }
        guard queuedBytes + bytes <= 131072, queue.count < 128 else { failed(code: 0, reason: "网络出现积压，正在重新连接"); return }
        queue.append((message, bytes)); queuedBytes += bytes
        #if DEBUG
        if case .data = message {
            audioEnqueued += 1
            if audioEnqueued <= 3 || audioEnqueued % 100 == 0 { print("[audio] queued=\(audioEnqueued) bytes=\(bytes)") }
        }
        #endif
        guard sendTask == nil else { return }
        let id = generation
        sendTask = Task { [weak self] in
            guard let self else { return }
            while !self.queue.isEmpty && self.generation == id && !Task.isCancelled {
                let item = self.queue[0]
                self.sendWatchdog = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled, let self, self.generation == id else { return }
                    self.failed(code: 0, reason: "音频上传暂时中断")
                }
                do {
                    try await socket.send(item.0)
                    #if DEBUG
                    if case .data = item.0 {
                        self.audioSent += 1
                        if self.audioSent <= 3 || self.audioSent % 100 == 0 { print("[audio] sent=\(self.audioSent)") }
                    }
                    #endif
                }
                catch {
                    try? await Task.sleep(for: .milliseconds(100))
                    guard self.generation == id, !Task.isCancelled else { return }
                    self.failed(code: socket.closeCode.rawValue, reason: "发送失败，正在尝试恢复"); return
                }
                guard self.generation == id else { return }
                self.sendWatchdog?.cancel(); self.queue.removeFirst(); self.queuedBytes -= item.1
            }
            if self.generation == id { self.sendTask = nil }
        }
    }
    private func monitorHost(id: UUID) {
        hostHeartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, let self, self.generation == id, let socket = self.socket else { return }
                let deadline = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled, let self, self.generation == id else { return }
                    self.end(); self.status = "主机连接中断，AOQ 通话已停止"
                }
                socket.sendPing { [weak self] error in
                    deadline.cancel()
                    guard error != nil else { return }
                    Task { @MainActor in guard let self, self.generation == id else { return }; self.end(); self.status = "主机连接中断，AOQ 通话已停止" }
                }
                // Ping callbacks own their timeout; do not let an old timeout affect a new connection.
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
    private func clearConnection() {
        dictationTask?.cancel(); dictationID = nil; dictationHolding = false; dictationRecording = false; dictationTranscribing = false; dictationCommands.removeAll()
        if textSending { inputNotice = "连接中断，草稿已保留。请先查看回复，避免重复发送。" }
        textTimeout?.cancel(); textRequest = nil; textSending = false; editableInput = false; pipeline = nil
        pairingTask?.cancel(); pairingTask = nil; pairingSession?.invalidateAndCancel(); pairingSession = nil; pairing = false
        generation = UUID(); connected = false; connecting = false; connection = nil
        receiveTask?.cancel(); sendTask?.cancel(); readyWatchdog?.cancel(); sendWatchdog?.cancel()
        receiveTask = nil; sendTask = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
        hostHeartbeat?.cancel(); hostHeartbeat = nil
        aoq?.stop(); aoq = nil; aoqRequest = nil; aoqBridge = nil; aoqChat = false; aoqRuntime = false; voiceStarting = false
        audio.disconnect(); voice = false; muted = false; inputLevel = 0
        queue.removeAll(); queuedBytes = 0; approvalRequests.removeAll()
        approvals.removeAll(); submitted.removeAll(); captions.removeAll(); captionSequence = -1
        taskStates.removeAll(); results.removeAll(); project = "Waiting for host state"; commandStatus = ""
    }
    private func failed(code: Int, reason: String) {
        clearConnection()
        let refusal = [4003: "连接密钥不正确，请在设置中检查", 4006: "客户端与 Mac 服务版本不兼容", 4009: "另一台设备正在通话，请先断开它"]
        if let message = refusal[code] { requested = false; status = message; return }
        status = code == 4008 ? "正在刷新连接" : reason
        guard requested else { return }
        guard let delay = recovery.nextDelay(atMS: Wire.renderMS) else {
            requested = false; status = "连接未恢复，请检查网络后重新连接。"; return
        }
        connecting = true
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.open()
        }
    }
    func end() {
        connectionRevision = UUID()
        requested = false; retryTask?.cancel(); retryTask = nil
        clearConnection(); status = "已断开"
    }
    func startVoice() async {
        guard connected, !voice, !voiceStarting, !dictationRecording, !dictationTranscribing, !textSending else { return }
        audio.stop()
        if editableInput { command(["type": "input.audio"]) }
        voiceStarting = true
        let id = generation
        let granted = await AVAudioApplication.requestRecordPermission()
        guard generation == id, connected, UIApplication.shared.applicationState == .active else { return }
        guard granted else { voiceStarting = false; status = "请在 iPhone 设置 → 隐私与安全性 → 麦克风中允许 Nova 使用麦克风。"; return }
        if aoqChat {
            guard let connection else { voiceStarting = false; return }
            let request = UUID().uuidString; aoqRequest = request
            do {
                let data = try JSONSerialization.data(withJSONObject: ["type": "aoq.connect", "connection_id": connection, "request_id": request])
                enqueue(.string(String(decoding: data, as: UTF8.self)), bytes: data.count)
                status = "正在连接 AOQ"
                readyWatchdog = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(25))
                    guard !Task.isCancelled, let self, self.generation == id, self.voiceStarting else { return }
                    self.end(); self.status = "AOQ 启动超时，请重新连接"
                }
            } catch { end(); status = "AOQ 请求失败" }
            return
        }
        do { try audio.start(threshold: speechThreshold); voiceStarting = false; voice = true; muted = false; speaker = false; status = "正在聆听" }
        catch { end(); status = error.localizedDescription }
    }
    func toggleMute() {
        guard voice, !voiceStarting else { return }
        do {
            if aoqChat { try aoq?.mute(!muted) } else { try audio.mute(!muted) }; muted.toggle()
            status = muted ? "麦克风已静音" : "正在聆听"
        }
        catch { end(); status = error.localizedDescription }
    }
    func toggleSpeaker() {
        guard voice, !voiceStarting else { return }
        do { if aoqChat { try aoq?.speaker(!speaker) } else { try audio.speaker(!speaker) }; speaker.toggle() }
        catch { status = error.localizedDescription }
    }
    func suspendAudio() {
        guard voice || voiceStarting else { return } // Permission UI may make a read-only connection inactive.
        end() // Stop capture and use the existing host connection-release boundary.
        status = "通话已结束"
    }
}
