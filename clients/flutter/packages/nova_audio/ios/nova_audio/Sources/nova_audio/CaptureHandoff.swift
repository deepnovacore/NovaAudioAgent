import Foundation

/// Single in-flight capture buffer; resetting invalidates a delayed Dart reply.
struct CaptureHandoff {
    private var serial = 0
    private var pending: (ticket: Int, since: Double)?
    mutating func offer(nowMS: Double) -> Int? {
        guard pending == nil else { return nil }
        serial += 1; pending = (serial, nowMS); return serial
    }
    mutating func acknowledge(_ ticket: Int) {
        if pending?.ticket == ticket { pending = nil }
    }
    func overloaded(nowMS: Double) -> Bool { pending.map { nowMS - $0.since >= 1000 } ?? false }
    mutating func reset() { serial += 1; pending = nil }
}
