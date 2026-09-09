import Foundation

struct PlaybackLedger {
    let maxSamples: Int
    private(set) var current: PlaybackIdentity?
    private(set) var ticket = UUID()
    private(set) var acceptedSamples = 0
    private(set) var renderedSamples = 0
    private var nextSequence = 0
    private var fencedEpoch = 0
    private var ended = false
    // Includes audio already scheduled on the player, not just network handoff.
    // Synthesis runs faster than playback; allow 60 seconds (5.76 MB as Float32).
    init(maxSamples: Int = 24000 * 60) { self.maxSamples = maxSamples }
    var playedMS: Int { renderedSamples * 1000 / 24000 }
    var finished: Bool { current != nil && ended && renderedSamples == acceptedSamples }

    mutating func accept(_ frame: AudioFrame) -> Bool {
        guard frame.identity.epoch > fencedEpoch, !ended,
              frame.pcm.count / 2 + acceptedSamples - renderedSamples <= maxSamples,
              frame.sequence == nextSequence,
              current == nil || current == frame.identity else { return false }
        current = frame.identity
        nextSequence += 1
        acceptedSamples += frame.pcm.count / 2
        return true
    }
    mutating func rendered(_ samples: Int, ticket: UUID) {
        guard ticket == self.ticket, current != nil else { return }
        renderedSamples = max(renderedSamples, min(acceptedSamples, max(0, samples)))
    }
    @discardableResult mutating func terminal(_ identity: PlaybackIdentity) -> Bool {
        if current == identity { ended = true }
        return finished
    }
    mutating func clear(_ identity: PlaybackIdentity) {
        guard current == nil || current == identity else { return }
        fencedEpoch = max(fencedEpoch, identity.epoch)
        reset()
    }
    mutating func disconnect() { fencedEpoch = 0; reset() }
    private mutating func reset() {
        current = nil; ticket = UUID(); acceptedSamples = 0; renderedSamples = 0
        nextSequence = 0; ended = false
    }
}

struct SpeechDetector {
    // ponytail: RMS detector after native AEC; tune threshold on hardware, replace with VAD if noise triggers it.
    var threshold: Float = 0.045
    private var attack = 0.0
    private var silence = 0.0
    private var active = false
    init(threshold: Float = 0.045) { self.threshold = threshold }
    mutating func observe(level: Float, durationMS: Double) -> Bool {
        if level >= threshold {
            silence = 0
            if active { return false }
            attack += durationMS
            if attack >= 50 { active = true; attack = 0; return true }
        } else {
            attack = 0; silence += durationMS
            if silence >= 180 { active = false }
        }
        return false
    }
}

// This is synthetic input, never microphone data. Match the 16 kHz PCM16 stream's clock.
struct MutedInput {
    private var nextMS: Double?
    private static let silence = Data(repeating: 0, count: 640)
    mutating func setMuted(_ muted: Bool, atMS now: Double) { nextMS = muted ? now + 20 : nil }
    mutating func packet(atMS now: Double) -> Data? {
        guard let nextMS, now >= nextMS else { return nil }
        self.nextMS = nextMS + (floor((now - nextMS) / 20) + 1) * 20 // Skip missed ticks; preserve pacing.
        return Self.silence
    }
}

func presentedSampleTime(renderTime: Int64, downstreamLatency: Double) -> Int64? {
    // In a real-time graph, zero may mean unknown. Only played-back completions are
    // evidence in that case. Round delay up to avoid crediting even a fractional sample early.
    guard downstreamLatency.isFinite, downstreamLatency > 0 else { return nil }
    let delay = (downstreamLatency * 24000).rounded(.up)
    guard delay < Double(max(0, renderTime)) else { return 0 }
    return renderTime - Int64(delay)
}
