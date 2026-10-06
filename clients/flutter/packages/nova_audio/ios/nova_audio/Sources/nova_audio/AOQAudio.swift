import Foundation
#if canImport(AoqClientSdk) && !targetEnvironment(simulator)
import AoqClientSdk

/// One SDK instance owns capture, AEC and playback for one connection.
@MainActor final class AOQAudio: NSObject, AoqEngineDelegate {
    static let available = true
    var onCaption: ((String, String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onReady: (() -> Void)?
    var onFailure: ((String) -> Void)?
    var onEvent: (([String: Any]) -> Void)?
    private var engine: AoqClientEngine?
    private var live = false
    private var configured = false
    private var session: [String: Any] = [:]
    private var assistant = ""
    private var watchdog: Task<Void, Never>?
    private var runtime = false
    private var connected = false
    private var pendingCommands = AOQPendingCommands()

    func start(_ payload: [String: Any], runtime: Bool = false) throws {
        guard engine == nil, let credentials = payload["credentials"] as? [String: Any] else { throw WireError("AOQ 会话配置无效") }
        if runtime {
            guard payload["mode"] as? String == "runtime", payload["session"] == nil else { throw WireError("AOQ Runtime 凭证无效") }
        } else {
            guard let settings = payload["session"] as? [String: Any], settings["tools"] == nil else { throw WireError("AOQ 会话配置无效") }
            session = settings
        }
        let config = AoqConnectConfig()
        func field(_ key: String, in source: [String: Any], max: Int = 8192) throws -> String {
            guard let value = source[key] as? String, !value.isEmpty, value.utf8.count <= max else { throw WireError("AOQ 连接凭证无效") }
            return value
        }
        config.token = try field("aoqTokenForClient", in: credentials)
        config.sid = try field("sid", in: credentials)
        config.certFingerprint = try field("clientRelayCertFingerprint", in: credentials)
        config.workspaceIdHash = try field("workspaceIdHash", in: credentials["extraInfo"] as? [String: Any] ?? [:])
        guard let endpoints = credentials["clientRelayEndpoints"] as? [[String: Any]], (1...8).contains(endpoints.count) else { throw WireError("AOQ 接入点无效") }
        config.relayEndpoints = try endpoints.map { value in
            let endpoint = AoqRelayEndpoint()
            endpoint.endpoint = try field("endpoint", in: value, max: 512)
            endpoint.port = try Wire.integer(value["port"], min: 1)
            endpoint.routeIndex = try Wire.integer(value["routeIndex"])
            guard endpoint.port <= 65535 else { throw WireError("AOQ 接入点无效") }
            return endpoint
        }
        let audioTrack = AoqTrackParam(); audioTrack.trackType = .audio
        let dataTrack = AoqTrackParam(); dataTrack.trackType = .data
        config.publishTracks = [audioTrack, dataTrack]; config.subscribeTracks = [audioTrack, dataTrack]
        let create = AoqCreateConfig()
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("AOQ")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        create.workDir = cache.path; create.enableDumpAudio = false; create.extras = "{}"
        self.runtime = runtime; live = true
        let engine = AoqClientEngine.createEngine(create, delegate: self); self.engine = engine
        do {
            let encoder = AoqAudioCodecConfig(); encoder.trackType = .audio; encoder.codecType = .audioPCM; encoder.sampleRate = 16000; encoder.channel = 1
            let decoder = AoqAudioCodecConfig(); decoder.trackType = .audio; decoder.codecType = .audioPCM; decoder.sampleRate = 24000; decoder.channel = 1
            try check(engine.setAudioEncoderConfig(encoder)); try check(engine.setAudioDecoderConfig(decoder))
            try check(engine.enableSendMediaStream(.audio, enable: false))
            let playback = AoqAudioPlaybackConfig(); playback.channel = 1; playback.isVoipMode = true; playback.isDefaultSpeaker = false
            try check(engine.startAudioPlayer(playback)); try check(engine.connect(config))
            watchdog = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, self.live, !self.configured else { return }
                self.fail("AOQ 连接超时，请结束后重新连接")
            }
        } catch { stop(); throw error }
    }
    private func check(_ code: Int32) throws { if code != 0 { throw WireError("AOQ 音频操作失败（\(code)）") } }
    private static func safeErrorCode(_ value: [String: Any]) -> String? {
        let raw = (value["error"] as? [String: Any])?["code"] ?? value["code"]
        let code = raw as? String ?? (raw as? NSNumber)?.stringValue
        guard let code, code.range(of: "^[A-Za-z0-9]{1,64}$", options: .regularExpression) != nil else { return nil }
        return code
    }
    private func send(_ value: [String: Any]) throws {
        guard let engine, live else { return }
        let message = AoqDataMsg(); message.data = try JSONSerialization.data(withJSONObject: value)
        try check(engine.send(message))
    }
    func mute(_ muted: Bool) throws { if let engine { try check(engine.muteAudioCapture(muted)) } }
    func speaker(_ enabled: Bool) throws {
        if let engine { try check(engine.enableSpeakerphone(enabled)) }
    }
    func command(_ event: [String: Any]) throws {
        guard live, runtime else { throw WireError("AOQ Runtime 尚未运行") }
        if connected { try send(event); return }
        try pendingCommands.append(event)
    }
    func interruptPlayback() throws { if let engine { try check(engine.interruptAudioPlayer(.audio, fadeMs: 30)) } }
    func stop() {
        live = false; connected = false; configured = false; watchdog?.cancel(); watchdog = nil
        session.removeAll(); _ = pendingCommands.drain()
        if let engine {
            _ = engine.enableSendMediaStream(.audio, enable: false)
            _ = engine.stopAudioCapture(); _ = engine.stopAudioPlayer(); _ = engine.disconnect()
            self.engine = nil; _ = AoqClientEngine.destroy()
        }
        onLevel?(0)
    }
    private func fail(_ reason: String) { guard live else { return }; stop(); onFailure?(reason) }
    private func receive(_ data: Data) {
        guard live else { return }
        do {
            let value = try Wire.json(data, limit: 65536)
            if runtime, let type = value["type"] as? String,
               ["session.created", "session.updated", "error", "response.function_call_arguments.done"].contains(type) {
                if type == "error", let code = Self.safeErrorCode(value) { NSLog("[NovaAOQ] event=error code=%@", code) }
                else { NSLog("[NovaAOQ] event=%@", type) }
            }
            if runtime { onEvent?(value) }
            switch value["type"] as? String {
            case "session.updated":
                guard !configured, let engine else { return }
                let capture = AoqAudioCaptureConfig(); capture.channel = 1; capture.isVoipMode = true
                try check(engine.startAudioCapture(capture))
                let volume = AoqAudioVolumeIndicationConfig(); volume.interval = 50; volume.smooth = 5
                try check(engine.enableLocalAudioVolumeIndication(volume))
                try check(engine.enableSendMediaStream(.audio, enable: true))
                configured = true; watchdog?.cancel(); NSLog("[NovaAOQ] capture ready"); onReady?()
            case "input_audio_buffer.speech_started":
                // Stop local buffered playout. Server endpointing owns model turn cancellation;
                // this is not a claim of per-response heard-time/truncation equivalence.
                if let engine { try check(engine.interruptAudioPlayer(.audio, fadeMs: 30)) }
            case "conversation.item.input_audio_transcription.completed":
                if let text = value["transcript"] as? String { onCaption?("user", String(text.prefix(8192))) }
            case "response.created": assistant = ""
            case "response.audio_transcript.delta", "response.output_audio_transcript.delta":
                if let delta = value["delta"] as? String { assistant = String((assistant + delta).prefix(8192)); onCaption?("assistant", assistant) }
            case "response.function_call_arguments.done": if !runtime { fail("AOQ 聊天模式不支持工具，请切回主机中转") }
            case "error": fail("AOQ 服务返回错误，请结束后重新连接")
            default: break
            }
        } catch { fail("AOQ 返回了不兼容的数据") }
    }
    nonisolated func onConnectionStatusChange(_ status: AoqConnectionStatus) {
        Task { @MainActor [weak self] in
            guard let self, self.live else { return }
            if status == .connected {
                self.connected = true
                if self.runtime {
                    do { for event in self.pendingCommands.drain() { try self.send(event) } }
                    catch { self.fail("AOQ Runtime 命令发送失败") }
                    return
                }
                do { try self.send(["type": "session.update", "session": self.session]); self.session.removeAll() }
                catch { self.fail("AOQ 会话配置失败") }
            } else if status == .failed || status == .disconnected { self.fail("AOQ 连接已断开") }
        }
    }
    nonisolated func onDataMsg(_ msg: AoqDataMsg) {
        guard msg.data.count <= 65536 else { Task { @MainActor [weak self] in self?.fail("AOQ 消息过大") }; return }
        let data = msg.data
        Task { @MainActor [weak self] in self?.receive(data) }
    }
    nonisolated func onLocalAudioVolumeIndication(_ volume: AoqAudioVolume) {
        let level = Float(max(0, min(255, volume.volume))) / 255
        Task { @MainActor [weak self] in guard let self, self.live else { return }; self.onLevel?(level) }
    }
    nonisolated func onError(_ code: Int, message: String) {
        NSLog("[NovaAOQ] sdk_error=%ld", code)
        Task { @MainActor [weak self] in self?.fail("AOQ 音频错误（\(code)）") }
    }
    nonisolated func onAudioDeviceInterrupted(_ interrupt: Bool) { if interrupt { Task { @MainActor [weak self] in self?.fail("音频被系统中断，请重新连接") } } }
    nonisolated func onAudioDeviceRouteChanged(_ routeType: Int) {
        Task { @MainActor [weak self] in
            guard let self, self.live else { return }
            // The SDK owns routing; capture startup also emits this notification.
            // Device failures and interruptions have separate callbacks below.
            NSLog("[NovaAOQ] route=%ld configured=%d", routeType, self.configured ? 1 : 0)
        }
    }
    nonisolated func onAudioDeviceStateChanged(_ state: AoqAudioDeviceState) {
        if state.state == .recordFail || state.state == .playFail {
            Task { @MainActor [weak self] in self?.fail("AOQ 音频设备启动失败") }
        }
    }
    nonisolated func onWarning(_ code: Int, message: String) {}
    nonisolated func onStats(_ stats: AoqStats) {}
    nonisolated func onAudioFileState(_ state: AoqAudioFileState) {}
    nonisolated func onVideoDeviceStateChanged(_ state: AoqVideoDeviceState) {}
}
#else
@MainActor final class AOQAudio {
    static let available = false
    var onCaption: ((String, String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onReady: (() -> Void)?
    var onFailure: ((String) -> Void)?
    var onEvent: (([String: Any]) -> Void)?
    func start(_ payload: [String: Any], runtime: Bool = false) throws { throw WireError("此构建未包含 AOQ SDK") }
    func command(_ event: [String: Any]) throws {}
    func interruptPlayback() throws {}
    func mute(_ muted: Bool) throws {}
    func speaker(_ enabled: Bool) throws {}
    func stop() {}
}
#endif
