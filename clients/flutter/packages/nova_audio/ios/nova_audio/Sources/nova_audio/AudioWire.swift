import Foundation
import CoreFoundation

struct WireError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}
struct PlaybackIdentity: Equatable {
    let utteranceID: String
    let epoch: Int
    var fields: [String: Any] { ["utterance_id": utteranceID, "generation_epoch": epoch] }
}
struct AudioFrame {
    let identity: PlaybackIdentity
    let sequence: Int
    let pcm: Data
}
enum Wire {
    static let maxPCM = 65536
    static let maxJSON = 16384
    static let maxHeader = 2048
    static let maxInteger = 9007199254740991

    static func endpoint(_ text: String, debugLocalhost: Bool = false) throws -> URL {
        guard var c = URLComponents(string: text), let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/" || c.path == "/client/v1" else { throw WireError("Enter a server URL without credentials or query parameters.") }
        var allowed = c.scheme == "wss"
        #if DEBUG
        allowed = allowed || (debugLocalhost && c.scheme == "ws" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
        #endif
        guard allowed else { throw WireError("A secure wss:// server is required.") }
        c.path = "/client/v1"
        guard let url = c.url else { throw WireError("Invalid server URL") }
        return url
    }

    static func json(_ data: Data, limit: Int = maxJSON) throws -> [String: Any] {
        guard data.count <= limit, let text = String(data: data, encoding: .utf8),
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw WireError("Invalid or oversized JSON") }
        // Foundation accepts 1.0 as Int. Inspect original root-member tokens so escaped and
        // duplicate keys obey the runtime's exact-integer contract (last member wins).
        let checked = Set(["generation_epoch", "sequence", "protocol_version", "played_ms"])
        let regex = try NSRegularExpression(pattern: #""(?:\\.|[^"\\])*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,]"#)
        let ns = text as NSString
        let tokens = regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
        var depth = 0
        var sources: [String: String] = [:]
        for i in tokens.indices {
            let token = tokens[i]
            if depth == 1 && token.hasPrefix("\"") && i + 2 < tokens.count && tokens[i+1] == ":",
               let key = try JSONSerialization.jsonObject(with: Data(token.utf8), options: .fragmentsAllowed) as? String, checked.contains(key) {
                sources[key] = tokens[i+2]
            }
            if token == "{" || token == "[" { depth += 1 }
            if token == "}" || token == "]" { depth -= 1 }
        }
        for (key, source) in sources where source != "null" {
            guard let integer = Int(source), integer >= 0, integer <= maxInteger, String(integer) == source else { throw WireError("Invalid integer: \(key)") }
        }
        return value
    }
    static func identifier(_ value: Any?) throws -> String {
        guard let string = value as? String, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              string.unicodeScalars.count <= 256 else { throw WireError("Invalid identity") }
        return string
    }
    static func integer(_ value: Any?, min: Int = 0) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue >= Double(min), number.doubleValue <= Double(maxInteger) else { throw WireError("Invalid integer") }
        return number.intValue
    }
    static func identity(_ value: [String: Any]) throws -> PlaybackIdentity {
        try PlaybackIdentity(utteranceID: identifier(value["utterance_id"]), epoch: integer(value["generation_epoch"], min: 1))
    }
    static func audio(_ data: Data) throws -> AudioFrame {
        guard data.count >= 8, data.count <= 6 + maxHeader + maxPCM, Array(data.prefix(4)) == [78,79,86,65] else { throw WireError("Invalid NOVA frame") }
        let bytes = [UInt8](data.prefix(6))
        let size = Int(bytes[4]) * 256 + Int(bytes[5])
        guard (2...maxHeader).contains(size), 6 + size < data.count else { throw WireError("Invalid audio header length") }
        let header = try json(data.subdata(in: 6..<(6+size)), limit: maxHeader)
        let pcm = data.subdata(in: (6+size)..<data.count)
        guard pcm.count <= maxPCM, pcm.count % 2 == 0 else { throw WireError("Invalid PCM16 length") }
        return try AudioFrame(identity: identity(header), sequence: integer(header["sequence"]), pcm: pcm)
    }
    static var renderMS: Double { ProcessInfo.processInfo.systemUptime * 1000 }
}
