// Adapted for Nova Audio Agent from qwen-audio-agent's macOS VoiceProcessingIO helper.
// Original: Copyright 2026 qwen-audio-agent contributors, Apache-2.0.
// Changes: Nova Audio Agent generation identity, bounded protocol, and delivery events.

import AudioToolbox
import Foundation

private let processingRate = 48_000.0
private let captureRate = 16_000.0
private let playbackRate = 24_000.0
private let maxAudioBytes = 65_536

private struct Command: Decodable {
    let type: String
    let audio: String?
    let utteranceId: String?
    let generationEpoch: Int?
    let enabled: Bool?
    let requestId: String?
}


private func check(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else {
        throw NSError(
            domain: "NovaAudioAgentVoiceIO",
            code: Int(status),
            userInfo: [NSLocalizedDescriptionKey: "\(operation) failed (CoreAudio \(status))"]
        )
    }
}

private func format(_ rate: Double) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(
        mSampleRate: rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2,
        mFramesPerPacket: 1,
        mBytesPerFrame: 2,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 16,
        mReserved: 0
    )
}

private func convert(
    _ input: UnsafeBufferPointer<Int16>,
    from sourceRate: Double,
    to targetRate: Double
) -> [Int16] {
    guard !input.isEmpty else { return [] }
    if abs(sourceRate - targetRate) < 1 { return Array(input) }
    let count = max(1, Int((Double(input.count) * targetRate / sourceRate).rounded()))
    let step = sourceRate / targetRate
    return (0..<count).map { index in
        let position = min(Double(input.count - 1), Double(index) * step)
        let lower = Int(position)
        let upper = min(input.count - 1, lower + 1)
        let fraction = position - Double(lower)
        let value = Double(input[lower]) * (1 - fraction) + Double(input[upper]) * fraction
        return Int16(max(Double(Int16.min), min(Double(Int16.max), value.rounded())))
    }
}

private final class VoiceIO {
    private let playback = PlaybackQueue()
    private let captureLock = NSLock()
    private let output = DispatchQueue(label: "nova-audio-agent.voice-io.output")
    private var captureEnabled = false
    private var unit: AudioUnit?
    private var running = false
    private var telemetryTimer: DispatchSourceTimer?

    func start() throws {
        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_VoiceProcessingIO,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )
        guard let component = AudioComponentFindNext(nil, &description) else {
            throw NSError(
                domain: "NovaAudioAgentVoiceIO",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "VoiceProcessingIO unavailable"]
            )
        }
        var created: AudioUnit?
        try check(AudioComponentInstanceNew(component, &created), "create VoiceProcessingIO")
        guard let created else { throw NSError(domain: "NovaAudioAgentVoiceIO", code: 2) }
        unit = created

        var enabled: UInt32 = 1
        try check(AudioUnitSetProperty(
            created,
            kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input,
            1,
            &enabled,
            UInt32(MemoryLayout<UInt32>.size)
        ), "enable microphone")

        var streamFormat = format(processingRate)
        let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitSetProperty(
            created,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input,
            0,
            &streamFormat,
            formatSize
        ), "set playback reference format")
        try check(AudioUnitSetProperty(
            created,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output,
            1,
            &streamFormat,
            formatSize
        ), "set echo-cancelled capture format")

        var playbackCallback = AURenderCallbackStruct(
            inputProc: renderCallback,
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        try check(AudioUnitSetProperty(
            created,
            kAudioUnitProperty_SetRenderCallback,
            kAudioUnitScope_Input,
            0,
            &playbackCallback,
            UInt32(MemoryLayout<AURenderCallbackStruct>.size)
        ), "set playback callback")

        var inputCallback = AURenderCallbackStruct(
            inputProc: captureCallback,
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        try check(AudioUnitSetProperty(
            created,
            kAudioOutputUnitProperty_SetInputCallback,
            kAudioUnitScope_Global,
            1,
            &inputCallback,
            UInt32(MemoryLayout<AURenderCallbackStruct>.size)
        ), "set capture callback")

        try check(AudioUnitInitialize(created), "initialize VoiceProcessingIO")
        try check(AudioOutputUnitStart(created), "start VoiceProcessingIO")
        running = true
        let timer = DispatchSource.makeTimerSource(queue: output)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.emitPlaybackTelemetry() }
        telemetryTimer = timer
        timer.resume()
        emit([
            "type": "ready",
            "aecMode": "voice_processing_io",
            "systemAEC": true,
            "inputSampleRate": captureRate,
            "outputSampleRate": playbackRate,
        ])
    }

    func setCapture(_ enabled: Bool) {
        captureLock.lock()
        captureEnabled = enabled
        captureLock.unlock()
    }

    func setPlaybackMuted(_ muted: Bool) {
        playback.setMuted(muted)
    }

    func emitPlaybackTelemetry(_ snapshot: PlaybackTelemetrySnapshot? = nil) {
        if let snapshot {
            emitPlaybackTelemetrySnapshot(snapshot)
            return
        }
        for stats in playback.takeTelemetrySnapshots() {
            emitPlaybackTelemetrySnapshot(stats)
        }
    }

    private func emitPlaybackTelemetrySnapshot(_ stats: PlaybackTelemetrySnapshot) {
        emit([
            "type": "playback.telemetry",
            "utteranceId": stats.identity.utteranceId,
            "generationEpoch": stats.identity.generationEpoch,
            "final": stats.final,
            "windowMs": min(stats.windowMs, 86_400_000),
            "queuedSamples": stats.queuedSamples,
            "queuedSamplesMax": stats.queuedSamplesMax,
            "underrunSamples": stats.underrunSamples,
            "underrunCallbacks": stats.underrunCallbacks,
            "maxConsecutiveUnderrunSamples": stats.maxConsecutiveUnderrunSamples,
            "renderCallbacks": stats.renderCallbacks,
            "maxCallbackUs": stats.maxCallbackUs,
            "pcmNearSilenceMsMax": stats.pcmNearSilenceSamplesMax / 48,
        ])
    }

    private func shouldCapture() -> Bool {
        captureLock.lock()
        defer { captureLock.unlock() }
        return captureEnabled
    }

    func enqueue(_ data: Data, identity: PlaybackIdentity) {
        guard !data.isEmpty, data.count <= maxAudioBytes, data.count % 2 == 0 else { return }
        let samples = data.withUnsafeBytes { bytes in
            convert(bytes.bindMemory(to: Int16.self), from: playbackRate, to: processingRate)
        }
        playback.append(samples, identity: identity)
    }

    func terminal(_ identity: PlaybackIdentity) { playback.terminal(identity) }
    func clear(_ identity: PlaybackIdentity? = nil, requestId: String? = nil) {
        let result = playback.clear(identity)
        for telemetry in result.telemetry { emitPlaybackTelemetry(telemetry) }
        guard let identity, let requestId else { return }
        emit([
            "type": "playback.cleared",
            "requestId": requestId,
            "utteranceId": identity.utteranceId,
            "generationEpoch": identity.generationEpoch,
            "renderedSamples": result.renderedSamples,
        ])
    }

    func render(_ buffers: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
        guard let buffers else { return noErr }
        for buffer in UnsafeMutableAudioBufferListPointer(buffers) {
            guard let data = buffer.mData else { continue }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size
            let destination = data.bindMemory(to: Int16.self, capacity: count)
            for signal in playback.render(
                into: UnsafeMutableBufferPointer(start: destination, count: count)
            ) {
                switch signal {
                case .started(let identity):
                    emit([
                        "type": "playback.started",
                        "utteranceId": identity.utteranceId,
                        "generationEpoch": identity.generationEpoch,
                    ])
                case .done(let identity, let renderedSamples, let telemetry):
                    emit([
                        "type": "playback.done",
                        "utteranceId": identity.utteranceId,
                        "generationEpoch": identity.generationEpoch,
                        "renderedSamples": renderedSamples,
                    ])
                    emitPlaybackTelemetry(telemetry)
                }
            }
        }
        return noErr
    }

    func capture(
        flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timestamp: UnsafePointer<AudioTimeStamp>,
        frameCount: UInt32
    ) -> OSStatus {
        guard let unit else { return kAudio_ParamError }
        var samples = [Int16](repeating: 0, count: Int(frameCount))
        let status = samples.withUnsafeMutableBytes { bytes -> OSStatus in
            var buffers = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(
                    mNumberChannels: 1,
                    mDataByteSize: UInt32(bytes.count),
                    mData: bytes.baseAddress
                )
            )
            return AudioUnitRender(unit, flags, timestamp, 1, frameCount, &buffers)
        }
        guard status == noErr, shouldCapture() else { return status }
        let converted = samples.withUnsafeBufferPointer {
            convert($0, from: processingRate, to: captureRate)
        }
        let data = converted.withUnsafeBytes { Data($0) }
        emit(["type": "audio", "audio": data.base64EncodedString()])
        return noErr
    }

    func stop() {
        telemetryTimer?.cancel()
        telemetryTimer = nil
        guard let unit else { return }
        if running { AudioOutputUnitStop(unit) }
        AudioUnitUninitialize(unit)
        AudioComponentInstanceDispose(unit)
        self.unit = nil
        running = false
    }

    private func emit(_ payload: [String: Any]) {
        output.async {
            guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        }
    }
}

private func renderCallback(
    _ context: UnsafeMutableRawPointer,
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ timestamp: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ buffers: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    Unmanaged<VoiceIO>.fromOpaque(context).takeUnretainedValue().render(buffers)
}

private func captureCallback(
    _ context: UnsafeMutableRawPointer,
    _ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    _ timestamp: UnsafePointer<AudioTimeStamp>,
    _ bus: UInt32,
    _ frames: UInt32,
    _ buffers: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {
    Unmanaged<VoiceIO>.fromOpaque(context).takeUnretainedValue().capture(
        flags: flags,
        timestamp: timestamp,
        frameCount: frames
    )
}

private func identity(_ command: Command) -> PlaybackIdentity? {
    guard
        let utteranceId = command.utteranceId,
        !utteranceId.isEmpty,
        utteranceId.count <= 256,
        let generationEpoch = command.generationEpoch,
        generationEpoch > 0
    else { return nil }
    return PlaybackIdentity(utteranceId: utteranceId, generationEpoch: generationEpoch)
}

@main
private enum VoiceIOProgram {
    static func main() {
        do {
            let voice = VoiceIO()
            try voice.start()
            while let line = readLine() {
                guard
                    line.utf8.count <= 100_000,
                    let data = line.data(using: .utf8),
                    let command = try? JSONDecoder().decode(Command.self, from: data)
                else { continue }
                switch command.type {
                case "play":
                    if
                        let encoded = command.audio,
                        let audio = Data(base64Encoded: encoded),
                        let identity = identity(command)
                    { voice.enqueue(audio, identity: identity) }
                case "terminal":
                    if let identity = identity(command) { voice.terminal(identity) }
                case "clear":
                    if
                        let requestId = command.requestId,
                        !requestId.isEmpty,
                        requestId.count <= 128,
                        let identity = identity(command)
                    {
                        voice.clear(identity, requestId: requestId)
                    } else {
                        voice.clear()
                    }
                case "capture": voice.setCapture(command.enabled == true)
                case "playback_muted": voice.setPlaybackMuted(command.enabled == true)
                case "playback_stats": voice.emitPlaybackTelemetry()
                case "close": voice.stop(); exit(0)
                default: continue
                }
            }
            voice.stop()
        } catch {
            let payload: [String: Any] = ["type": "error", "code": "voice_processing_unavailable"]
            if let data = try? JSONSerialization.data(withJSONObject: payload) {
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write(Data([0x0A]))
            }
            exit(1)
        }
    }
}
