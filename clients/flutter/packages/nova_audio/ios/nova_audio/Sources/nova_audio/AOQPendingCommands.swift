import Foundation
struct AOQPendingCommands {
    private static let maxBytes = 262_144
    private var values: [[String: Any]] = []
    private var bytes = 0

    mutating func append(_ event: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(event) else { throw WireError("Invalid AOQ command") }
        let size = try JSONSerialization.data(withJSONObject: event).count
        guard bytes + size <= Self.maxBytes else { throw WireError("AOQ Runtime 命令积压") }
        values.append(event); bytes += size
    }

    mutating func drain() -> [[String: Any]] {
        defer { values.removeAll(); bytes = 0 }
        return values
    }
}
