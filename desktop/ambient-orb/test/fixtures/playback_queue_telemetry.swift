import Foundation

private func render(_ queue: PlaybackQueue, count: Int) -> [PlaybackSignal] {
    var samples = [Int16](repeating: -1, count: count)
    return samples.withUnsafeMutableBufferPointer { queue.render(into: $0) }
}

let queue = PlaybackQueue()
precondition(render(queue, count: 4).isEmpty)
precondition(queue.snapshotTelemetry() == nil, "idle callbacks are not generation telemetry")

let first = PlaybackIdentity(utteranceId: "u-1", generationEpoch: 1)
queue.append([1, 2], identity: first)
queue.terminal(first)
let second = PlaybackIdentity(utteranceId: "u-2", generationEpoch: 2)
queue.append([0, 0, 3, 4], identity: second)
let firstSignals = render(queue, count: 4)
precondition(firstSignals.contains { signal in
    if case .started(let identity) = signal { return identity == first }
    return false
}, "the first generation starts even after the next generation has queued")
let terminalSignals = render(queue, count: 4)
let final = terminalSignals.compactMap { signal -> PlaybackTelemetrySnapshot? in
    if case .done(let identity, let renderedSamples, let telemetry) = signal {
        precondition(identity == first)
        precondition(renderedSamples == 2)
        return telemetry
    }
    return nil
}.first
precondition(final?.final == true, "short generations must produce a final snapshot")
precondition(final?.underrunSamples == 2, "the first generation keeps its transition underrun")
precondition(final?.maxConsecutiveUnderrunSamples == 2)
precondition(final?.queuedSamples == 0, "the first generation queue drains independently")

let isolated = queue.snapshotTelemetry()
precondition(isolated?.identity == second)
precondition(isolated?.underrunSamples == 0)
precondition(isolated?.underrunCallbacks == 0)

let cleared = queue.clear(second)
precondition(cleared.telemetry.map(\.identity) == [second])
precondition(cleared.telemetry.first?.final == true)

let silenceQueue = PlaybackQueue()
let quiet = PlaybackIdentity(utteranceId: "u-quiet", generationEpoch: 3)
silenceQueue.append([Int16](repeating: 24, count: 96) + [120], identity: quiet)
let firstWindow = silenceQueue.takeTelemetrySnapshots()
precondition(firstWindow.first?.pcmNearSilenceSamplesMax == 96)
let resetWindow = silenceQueue.takeTelemetrySnapshots()
precondition(resetWindow.first?.pcmNearSilenceSamplesMax == 0,
             "near-silence maxima reset at each telemetry window")

let gapQueue = PlaybackQueue()
let gap = PlaybackIdentity(utteranceId: "u-gap", generationEpoch: 5)
gapQueue.append([1], identity: gap)
_ = render(gapQueue, count: 3)
precondition(gapQueue.takeTelemetrySnapshots().first?.maxConsecutiveUnderrunSamples == 2)
_ = render(gapQueue, count: 3)
precondition(gapQueue.takeTelemetrySnapshots().first?.maxConsecutiveUnderrunSamples == 3,
             "consecutive underrun maxima reset instead of accumulating across windows")

let clearingAll = PlaybackQueue()
let third = PlaybackIdentity(utteranceId: "u-3", generationEpoch: 3)
let fourth = PlaybackIdentity(utteranceId: "u-4", generationEpoch: 4)
clearingAll.append([1], identity: third)
clearingAll.append([2], identity: fourth)
precondition(Set(clearingAll.clear().telemetry.map(\.identity)) == Set([third, fourth]),
             "clear-all emits one final snapshot for every queued generation")
print("playback telemetry behavior passed")
