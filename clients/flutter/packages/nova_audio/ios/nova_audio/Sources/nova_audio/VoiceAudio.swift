import AVFoundation
import Foundation

// One capture handoff may wait on the UI executor. A stalled UI cannot accumulate microphone buffers.
private final class CaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var received = false
    var hasReceived: Bool { lock.lock(); defer { lock.unlock() }; return received }
    func acquire() -> Bool { lock.lock(); defer { lock.unlock() }; received = true; if busy { return false }; busy = true; return true }
    func release() { lock.lock(); busy = false; lock.unlock() }
}

@MainActor final class VoiceAudio {
    var onPCM: ((Data) -> Void)?
    var onLevel: ((Float) -> Void)?
    private var lastLevelMS: Double = 0
    private var level: Float = 0
    private var pcmCount = 0
    private var captureGate = CaptureGate()
    private var startupReconfigurations = 0
    var onControl: (([String: Any]) -> Void)?
    var onStopped: ((String) -> Void)?
    private(set) var running = false
    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private let outputFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    private var ledger = PlaybackLedger()
    private var detector = SpeechDetector()
    private var mutedInput = MutedInput()
    private var captureID = UUID()
    private var tapping = false
    private var completedSamples = 0
    private var scheduledEnd: AVAudioFramePosition = 0
    private var segments: [(id: UUID, start: Int64, count: Int)] = []
    private var started = false
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            guard let changedEngine = note.object as? AVAudioEngine else { return }
            Task { @MainActor in
                guard let self, self.engine === changedEngine, self.running else { return }
                let capture = self.tapping
                guard (!capture || !self.captureGate.hasReceived), self.startupReconfigurations < 2 else {
                    self.stop(); self.onStopped?("音频设备配置已变化，请重新连接。"); return
                }
                self.startupReconfigurations += 1
                self.clearCurrent(type: "playback.stopped")
                self.engine.stop()
                self.captureID = UUID()
                if self.tapping { self.engine.inputNode.removeTap(onBus: 0); self.tapping = false }
                do {
                    self.engine.connect(self.engine.mainMixerNode, to: self.engine.outputNode, format: nil)
                    if capture { try self.installCapture() }
                    self.engine.prepare(); try self.engine.start()
                    #if DEBUG
                    print("[audio] restarted after startup configuration change")
                    #endif
                } catch { self.stop(); self.onStopped?(error.localizedDescription) }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                Task { @MainActor in self?.stop(); self?.onStopped?("Audio interrupted. Reconnect to resume.") }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue || reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue {
                Task { @MainActor in
                    guard let self, self.running else { return }
                    self.stop(); self.onStopped?("Audio route changed. Reconnect to use the new route.")
                }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.stop(); self?.onStopped?("Audio service reset. Reconnect to resume.") }
        })
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func start(threshold: Float, capture: Bool = true) throws {
        guard !running else { return }
        pcmCount = 0; captureGate = CaptureGate(); startupReconfigurations = 0
        let session = AVAudioSession.sharedInstance()
        if capture { try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth]) }
        else { try session.setCategory(.playback, mode: .default) }
        try session.setPreferredSampleRate(48000)
        try session.setPreferredIOBufferDuration(0.01)
        try session.setActive(true)
        do {
            engine = AVAudioEngine(); player = AVAudioPlayerNode()
            engine.attach(player)
            if capture { try engine.inputNode.setVoiceProcessingEnabled(true) }
            engine.connect(player, to: engine.mainMixerNode, format: outputFormat)
            detector = SpeechDetector(threshold: threshold)
            if capture { try installCapture() }
            engine.prepare(); try engine.start()
            running = true
            #if DEBUG
            print("[audio] engine started running=\(engine.isRunning) capture=\(capture) available=\(session.isInputAvailable)")
            print("[audio] graph \(engine.description)")
            #endif
            timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        } catch { stop(); throw error }
    }

    func mute(_ muted: Bool) throws {
        level = 0; onLevel?(0)
        captureID = UUID()
        if tapping { engine.inputNode.removeTap(onBus: 0); tapping = false }
        detector = SpeechDetector(threshold: detector.threshold)
        mutedInput.setMuted(muted, atMS: Wire.renderMS)
        if !muted && running { try installCapture() }
    }
    func speaker(_ enabled: Bool) throws {
        try AVAudioSession.sharedInstance().overrideOutputAudioPort(enabled ? .speaker : .none)
    }
    private func installCapture() throws {
        let source = engine.inputNode.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target) else { throw WireError("Microphone format unavailable") }
        let id = captureID
        let gate = captureGate
        var tapCount = 0
        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: source) { [weak self] input, _ in
            tapCount += 1
            #if DEBUG
            if tapCount <= 3 || tapCount % 100 == 0 { print("[audio] tap=\(tapCount) frames=\(input.frameLength)") }
            #endif
            guard gate.acquire() else { return }
            let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16000 / source.sampleRate) + 32)
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { gate.release(); return }
            var supplied = false
            var error: NSError?
            let result = converter.convert(to: output, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return input
            }
            guard error == nil, result != .error else {
                Task { @MainActor in
                    defer { gate.release() }
                    guard let self, self.captureID == id else { return }
                    self.stop(); self.onStopped?("Microphone conversion failed. Reconnect to retry.")
                }
                return
            }
            #if DEBUG
            if tapCount <= 3 || tapCount % 100 == 0 { print("[audio] converted=\(output.frameLength) status=\(result.rawValue) int16=\(output.int16ChannelData != nil)") }
            #endif
            guard output.frameLength > 0, let samples = output.int16ChannelData?[0] else { gate.release(); return }
            let count = Int(output.frameLength)
            let pcm = Data(bytes: samples, count: count * 2) // All supported Apple CPUs are little endian.
            var square: Double = 0
            for i in 0..<count { let value = Double(samples[i]) / 32768; square += value * value }
            let rms = Float(sqrt(square / Double(count)))
            Task { @MainActor in
                defer { gate.release() }
                guard let self, self.running, self.captureID == id else { return }
                if self.detector.observe(level: rms, durationMS: Double(count) / 16) {
                    self.clearCurrent(type: "playback.stopped")
                    self.onControl?(["type": "speech.onset", "speech_id": UUID().uuidString, "t_render_ms": Wire.renderMS])
                }
                let target = min(1, rms * 8)
                let duration = Double(count) / 16
                let tau = target > self.level ? 140.0 : 480.0
                self.level += (target - self.level) * Float(1 - exp(-duration / tau))
                if Wire.renderMS - self.lastLevelMS >= 50 {
                    self.lastLevelMS = Wire.renderMS; self.onLevel?(self.level)
                }
                self.pcmCount += 1
                #if DEBUG
                if self.pcmCount <= 3 || self.pcmCount % 100 == 0 { print("[audio] handoff=\(self.pcmCount) bytes=\(pcm.count) rms=\(rms)") }
                #endif
                self.onPCM?(pcm)
            }
        }
        tapping = true
    }

    func receive(_ frame: AudioFrame) throws {
        updateRendered()
        guard running else {
            if ledger.accept(frame) { clearCurrent(type: "playback.stopped") }
            return
        }
        guard ledger.accept(frame) else {
            #if DEBUG
            print("[audio] frame rejected sequence=\(frame.sequence) samples=\(frame.pcm.count / 2) accepted=\(ledger.acceptedSamples) rendered=\(ledger.renderedSamples) limit=\(ledger.maxSamples) segments=\(segments.count) sameGeneration=\(ledger.current == frame.identity)")
            #endif
            if ledger.current == frame.identity { clearCurrent(type: "playback.stopped") }
            return
        }
        guard segments.count < 512, let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(frame.pcm.count / 2)) else {
            #if DEBUG
            print("[audio] scheduling rejected segments=\(segments.count) samples=\(frame.pcm.count / 2)")
            #endif
            clearCurrent(type: "playback.stopped"); return
        }
        let count = frame.pcm.count / 2
        buffer.frameLength = AVAudioFrameCount(count)
        let bytes = [UInt8](frame.pcm)
        for i in 0..<count {
            buffer.floatChannelData![0][i] = Float(Int16(bitPattern: UInt16(bytes[i*2]) | UInt16(bytes[i*2+1]) << 8)) / 32768
        }
        let now = player.lastRenderTime.flatMap { player.playerTime(forNodeTime: $0)?.sampleTime } ?? 0
        let start = max(scheduledEnd, now)
        scheduledEnd = start + Int64(count)
        let segmentID = UUID(), ticket = ledger.ticket
        segments.append((segmentID, start, count))
        player.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: start, atRate: 24000), options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.ledger.ticket == ticket,
                      let index = self.segments.firstIndex(where: { $0.id == segmentID }) else { return }
                self.completedSamples += self.segments.remove(at: index).count
                self.updateRendered()
            }
        }
        if !player.isPlaying { player.play() }
    }
    func terminal(_ identity: PlaybackIdentity) { ledger.terminal(identity); updateRendered() }
    func clear(_ identity: PlaybackIdentity) {
        guard ledger.current == nil || ledger.current == identity else { return }
        if ledger.current != nil { clearCurrent(type: "playback.cleared") }
        else {
            ledger.clear(identity)
            report("playback.cleared", identity, played: 0)
        }
    }
    private func tick() {
        updateRendered()
        if running, let pcm = mutedInput.packet(atMS: Wire.renderMS) { onPCM?(pcm) }
    }
    private func updateRendered() {
        guard let identity = ledger.current else { return }
        // The player's full downstream latency includes Voice Processing and device
        // presentation. Query it live; adding session latency again would double-count it.
        let time = player.lastRenderTime.flatMap { player.playerTime(forNodeTime: $0)?.sampleTime } ?? 0
        let audible = presentedSampleTime(renderTime: time, downstreamLatency: player.outputPresentationLatency) ?? 0
        let partial = segments.reduce(0) { $0 + Int(max(0, min(Int64($1.count), audible - $1.start))) }
        ledger.rendered(completedSamples + partial, ticket: ledger.ticket)
        if !started && ledger.renderedSamples > 0 {
            started = true; report("playback.started", identity)
        }
        // A terminal is complete only once all scheduled buffers have actually played back.
        if ledger.finished && segments.isEmpty {
            report("playback.done", identity, played: ledger.playedMS)
            ledger.clear(identity); resetPlayer()
        }
    }
    private func clearCurrent(type: String) {
        updateRendered()
        guard let identity = ledger.current else { return }
        let played = ledger.playedMS
        #if DEBUG
        print("[audio] clear type=\(type) playedMS=\(played) queuedSamples=\(ledger.acceptedSamples - ledger.renderedSamples) running=\(running)")
        #endif
        ledger.clear(identity) // Fence callbacks before stop(), which invokes completions.
        resetPlayer()
        report(type, identity, played: played)
    }
    private func resetPlayer() {
        player.stop(); segments.removeAll(); completedSamples = 0; scheduledEnd = 0; started = false
    }
    private func report(_ type: String, _ identity: PlaybackIdentity, played: Int? = nil) {
        var value = identity.fields
        value["type"] = type; value["t_render_ms"] = Wire.renderMS
        if let played { value["played_ms"] = played }
        onControl?(value)
    }
    func stop() {
        level = 0; onLevel?(0)
        captureID = UUID(); mutedInput.setMuted(false, atMS: Wire.renderMS)
        clearCurrent(type: "playback.stopped")
        timer?.invalidate(); timer = nil
        if tapping { engine.inputNode.removeTap(onBus: 0); tapping = false }
        engine.stop(); resetPlayer(); running = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func disconnect() { stop(); ledger.disconnect() }
}
