import Dispatch
import Foundation

let maxCompletedPlayback = 32
let nearSilenceAmplitudeThreshold: Int16 = 33

struct PlaybackIdentity: Hashable {
    let utteranceId: String
    let generationEpoch: Int
}

struct PlaybackTelemetrySnapshot {
    let identity: PlaybackIdentity
    let final: Bool
    let windowMs: Int
    let queuedSamples: Int
    let queuedSamplesMax: Int
    let underrunSamples: Int
    let underrunCallbacks: Int
    let maxConsecutiveUnderrunSamples: Int
    let renderCallbacks: Int
    let maxCallbackUs: Int
    let pcmNearSilenceSamplesMax: Int
}

enum PlaybackSignal {
    case started(PlaybackIdentity)
    case done(PlaybackIdentity, Int, PlaybackTelemetrySnapshot)
}

struct PlaybackClearResult {
    let renderedSamples: Int
    let telemetry: [PlaybackTelemetrySnapshot]
}

private enum PlaybackEntry {
    case audio(PlaybackIdentity, [Int16], Int)
    case terminal(PlaybackIdentity)
}

private struct PlaybackTelemetryCounters {
    let identity: PlaybackIdentity
    let startedAtNs: UInt64
    var queuedSamples = 0
    var queuedSamplesMax = 0
    var underrunSamples = 0
    var underrunCallbacks = 0
    var consecutiveUnderrunSamples = 0
    var maxConsecutiveUnderrunSamples = 0
    var renderCallbacks = 0
    var maxCallbackUs: UInt64 = 0
    var consecutiveNearSilenceSamples = 0
    var pcmNearSilenceSamplesMax = 0

    func snapshot(final: Bool, nowNs: UInt64) -> PlaybackTelemetrySnapshot {
        PlaybackTelemetrySnapshot(
            identity: identity,
            final: final,
            windowMs: Int((nowNs - startedAtNs) / 1_000_000),
            queuedSamples: queuedSamples,
            queuedSamplesMax: queuedSamplesMax,
            underrunSamples: underrunSamples,
            underrunCallbacks: underrunCallbacks,
            maxConsecutiveUnderrunSamples: maxConsecutiveUnderrunSamples,
            renderCallbacks: renderCallbacks,
            maxCallbackUs: Int(min(maxCallbackUs, UInt64(Int.max))),
            pcmNearSilenceSamplesMax: pcmNearSilenceSamplesMax
        )
    }
}

private struct NearSilenceRun {
    let leading: Int
    let trailing: Int
    let longest: Int
    let fillsFrame: Bool
}

private func nearSilenceRun(_ samples: [Int16]) -> NearSilenceRun {
    var leading = 0
    var trailing = 0
    var longest = 0
    var current = 0
    for sample in samples {
        if sample >= -nearSilenceAmplitudeThreshold && sample <= nearSilenceAmplitudeThreshold {
            current += 1
            longest = max(longest, current)
            if leading == current - 1 { leading = current }
        } else {
            current = 0
        }
    }
    trailing = current
    return NearSilenceRun(
        leading: leading,
        trailing: trailing,
        longest: longest,
        fillsFrame: leading == samples.count
    )
}

final class PlaybackQueue {
    private let lock = NSLock()
    private var entries: [PlaybackEntry] = []
    private var started = Set<PlaybackIdentity>()
    private var renderedSamples: [PlaybackIdentity: Int] = [:]
    private var completedSamples: [PlaybackIdentity: Int] = [:]
    private var completedOrder: [PlaybackIdentity] = []
    private var activeRenderIdentity: PlaybackIdentity?
    private var muted = false
    private var telemetry: [PlaybackIdentity: PlaybackTelemetryCounters] = [:]
    private var telemetryOrder: [PlaybackIdentity] = []

    func setMuted(_ value: Bool) {
        lock.lock()
        muted = value
        lock.unlock()
    }

    func snapshotTelemetry() -> PlaybackTelemetrySnapshot? {
        lock.lock()
        defer { lock.unlock() }
        guard let identity = telemetryOrder.last, let current = telemetry[identity] else { return nil }
        return current.snapshot(final: false, nowNs: DispatchTime.now().uptimeNanoseconds)
    }

    /** Periodic non-realtime sample of every live generation; window maxima reset after capture. */
    func takeTelemetrySnapshots() -> [PlaybackTelemetrySnapshot] {
        lock.lock()
        defer { lock.unlock() }
        let now = DispatchTime.now().uptimeNanoseconds
        let snapshots = telemetryOrder.compactMap { identity in
            telemetry[identity]?.snapshot(final: false, nowNs: now)
        }
        for identity in telemetryOrder {
            guard var current = telemetry[identity] else { continue }
            current.consecutiveUnderrunSamples = 0
            current.maxConsecutiveUnderrunSamples = 0
            current.consecutiveNearSilenceSamples = 0
            current.pcmNearSilenceSamplesMax = 0
            telemetry[identity] = current
        }
        return snapshots
    }

    func append(_ samples: [Int16], identity: PlaybackIdentity) {
        guard !samples.isEmpty else { return }
        let silence = nearSilenceRun(samples)
        lock.lock()
        if telemetry[identity] == nil {
            telemetry[identity] = PlaybackTelemetryCounters(
                identity: identity,
                startedAtNs: DispatchTime.now().uptimeNanoseconds
            )
        }
        telemetryOrder.removeAll { $0 == identity }
        telemetryOrder.append(identity)
        while telemetryOrder.count > maxCompletedPlayback {
            telemetry.removeValue(forKey: telemetryOrder.removeFirst())
        }
        if var current = telemetry[identity] {
            current.queuedSamples += samples.count
            current.queuedSamplesMax = max(current.queuedSamplesMax, current.queuedSamples)
            let joinedLeading = current.consecutiveNearSilenceSamples + silence.leading
            current.pcmNearSilenceSamplesMax = max(
                current.pcmNearSilenceSamplesMax,
                joinedLeading,
                silence.longest
            )
            current.consecutiveNearSilenceSamples = silence.fillsFrame
                ? joinedLeading
                : silence.trailing
            telemetry[identity] = current
        }
        completedSamples.removeValue(forKey: identity)
        completedOrder.removeAll { $0 == identity }
        entries.append(.audio(identity, samples, 0))
        lock.unlock()
    }

    func terminal(_ identity: PlaybackIdentity) {
        lock.lock()
        entries.append(.terminal(identity))
        lock.unlock()
    }

    func clear(_ identity: PlaybackIdentity? = nil) -> PlaybackClearResult {
        lock.lock()
        defer { lock.unlock() }
        guard let identity else {
            let now = DispatchTime.now().uptimeNanoseconds
            let telemetrySnapshots = telemetryOrder.compactMap { candidate in
                telemetry[candidate]?.snapshot(
                    final: true,
                    nowNs: now
                )
            }
            entries.removeAll(keepingCapacity: true)
            started.removeAll(keepingCapacity: true)
            renderedSamples.removeAll(keepingCapacity: true)
            completedSamples.removeAll(keepingCapacity: true)
            completedOrder.removeAll(keepingCapacity: true)
            activeRenderIdentity = nil
            telemetry.removeAll(keepingCapacity: true)
            telemetryOrder.removeAll(keepingCapacity: true)
            return PlaybackClearResult(renderedSamples: 0, telemetry: telemetrySnapshots)
        }
        let telemetrySnapshot = telemetry[identity]?.snapshot(
            final: true,
            nowNs: DispatchTime.now().uptimeNanoseconds
        )
        var retained: [PlaybackEntry] = []
        retained.reserveCapacity(entries.count)
        var removedSamples = 0
        for entry in entries {
            switch entry {
            case .audio(let candidate, let samples, let consumedOffset) where candidate == identity:
                removedSamples += max(0, samples.count - consumedOffset)
            case .terminal(let candidate) where candidate == identity:
                continue
            default:
                retained.append(entry)
            }
        }
        entries = retained
        if var current = telemetry[identity] {
            current.queuedSamples = max(0, current.queuedSamples - removedSamples)
            telemetry[identity] = current
        }
        started.remove(identity)
        if activeRenderIdentity == identity { activeRenderIdentity = nil }
        let rendered = max(
            renderedSamples.removeValue(forKey: identity) ?? 0,
            completedSamples.removeValue(forKey: identity) ?? 0
        )
        completedOrder.removeAll { $0 == identity }
        telemetry.removeValue(forKey: identity)
        telemetryOrder.removeAll { $0 == identity }
        return PlaybackClearResult(
            renderedSamples: rendered,
            telemetry: telemetrySnapshot.map { [$0] } ?? []
        )
    }

    func render(into output: UnsafeMutableBufferPointer<Int16>) -> [PlaybackSignal] {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        output.baseAddress?.initialize(repeating: 0, count: output.count)
        var signals: [PlaybackSignal] = []
        var completed: [(PlaybackIdentity, Int)] = []
        var offset = 0
        var consumedIdentities = Set<PlaybackIdentity>()
        var callbackIdentity: PlaybackIdentity?
        lock.lock()
        renderLoop: while offset < output.count, !entries.isEmpty {
            switch entries[0] {
            case .terminal(let identity):
                if consumedIdentities.contains(identity) { break renderLoop }
                entries.removeFirst()
                started.remove(identity)
                if activeRenderIdentity == identity { activeRenderIdentity = nil }
                let rendered = renderedSamples.removeValue(forKey: identity) ?? 0
                completedSamples[identity] = rendered
                completedOrder.removeAll { $0 == identity }
                completedOrder.append(identity)
                while completedOrder.count > maxCompletedPlayback {
                    completedSamples.removeValue(forKey: completedOrder.removeFirst())
                }
                completed.append((identity, rendered))
            case .audio(let identity, let samples, let consumedOffset):
                if !started.contains(identity) {
                    started.insert(identity)
                    signals.append(.started(identity))
                }
                let amount = min(output.count - offset, samples.count - consumedOffset)
                if !muted {
                    samples.withUnsafeBufferPointer { source in
                        output.baseAddress?.advanced(by: offset).update(
                            from: source.baseAddress!.advanced(by: consumedOffset),
                            count: amount
                        )
                    }
                }
                offset += amount
                if amount > 0 {
                    consumedIdentities.insert(identity)
                    callbackIdentity = identity
                    activeRenderIdentity = identity
                    renderedSamples[identity, default: 0] += amount
                    if var current = telemetry[identity] {
                        current.queuedSamples = max(0, current.queuedSamples - amount)
                        telemetry[identity] = current
                    }
                }
                let next = consumedOffset + amount
                if next == samples.count {
                    entries.removeFirst()
                } else {
                    entries[0] = .audio(identity, samples, next)
                }
            }
        }
        let measuredIdentity = callbackIdentity ?? activeRenderIdentity
        if let identity = measuredIdentity, var current = telemetry[identity] {
            if started.contains(identity), offset < output.count {
                let missing = output.count - offset
                current.underrunSamples += missing
                current.underrunCallbacks += 1
                current.consecutiveUnderrunSamples += missing
                current.maxConsecutiveUnderrunSamples = max(
                    current.maxConsecutiveUnderrunSamples,
                    current.consecutiveUnderrunSamples
                )
            } else {
                current.consecutiveUnderrunSamples = 0
            }
            current.renderCallbacks += 1
            let elapsedUs = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000
            current.maxCallbackUs = max(current.maxCallbackUs, elapsedUs)
            telemetry[identity] = current
        }
        for (identity, rendered) in completed {
            if let current = telemetry[identity] {
                signals.append(.done(
                    identity,
                    rendered,
                    current.snapshot(final: true, nowNs: DispatchTime.now().uptimeNanoseconds)
                ))
                telemetry.removeValue(forKey: identity)
                telemetryOrder.removeAll { $0 == identity }
            }
        }
        lock.unlock()
        return signals
    }
}
