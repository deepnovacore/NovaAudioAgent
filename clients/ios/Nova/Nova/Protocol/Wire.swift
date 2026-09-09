import Foundation

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
struct Ready {
    let instance: UUID
    let connection: String
    let pipeline: String?
    let editableInput: Bool
    let aoqChat: Bool
    let aoqRuntime: Bool
}

struct AOQRuntimeBridge {
    static let maxEvent = 65_536
    static let maxEnvelope = 131_072
    private static let commands = Set(["session.update", "conversation.item.create", "conversation.item.delete",
                                       "conversation.item.truncate", "input_audio_buffer.clear", "response.create", "response.cancel"])
    private let connection: String
    private var commandSequence = 0
    private var eventSequence = 0

    init(connection: String) { self.connection = connection }

    mutating func command(_ value: [String: Any]) throws -> [String: Any] {
        guard Set(value.keys) == Set(["type", "connection_id", "sequence", "event"]),
              value["type"] as? String == "aoq.command", value["connection_id"] as? String == connection,
              try Wire.integer(value["sequence"], min: 1) == commandSequence + 1,
              let event = value["event"] as? [String: Any], let type = event["type"] as? String,
              Self.commands.contains(type), try Self.size(event) <= Self.maxEvent else { throw WireError("Invalid AOQ command") }
        commandSequence += 1
        return event
    }

    mutating func envelope(_ event: [String: Any]) throws -> [String: Any]? {
        guard let type = event["type"] as? String else { throw WireError("Invalid AOQ event") }
        if ["response.audio.delta", "response.output_audio.delta", "input_audio_buffer.append"].contains(type) { return nil }
        guard try Self.size(event) <= Self.maxEvent else { throw WireError("AOQ event too large") }
        let value: [String: Any] = ["type": "aoq.event", "connection_id": connection,
                                   "sequence": eventSequence + 1, "event": event]
        guard try Self.size(value) <= Self.maxEnvelope else { throw WireError("AOQ envelope too large") }
        eventSequence += 1
        return value
    }

    private static func size(_ value: [String: Any]) throws -> Int {
        guard JSONSerialization.isValidJSONObject(value) else { throw WireError("Invalid AOQ JSON") }
        return try JSONSerialization.data(withJSONObject: value).count
    }
}

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
    static func ready(_ value: [String: Any], allowAOQ: Bool = false, allowAOQRuntime: Bool = false) throws -> Ready {
        guard value["type"] as? String == "client.ready", try integer(value["protocol_version"]) == 1,
              let instance = (value["server_instance_id"] as? String).flatMap(UUID.init(uuidString:)),
              let connection = value["connection_id"] as? String, UUID(uuidString: connection) != nil,
              let capabilities = value["capabilities"] as? [String], Set(["audio", "captions"]).isSubset(of: Set(capabilities)) else { throw WireError("Incompatible server handshake") }
        for (key, rate) in [("input_audio", 16000), ("output_audio", 24000)] {
            guard let format = value[key] as? [String: Any], format["encoding"] as? String == "pcm_s16le",
                  try integer(format["sample_rate"]) == rate, try integer(format["channels"]) == 1 else { throw WireError("Unsupported audio format") }
        }
        var pipeline: String?
        var aoqChat = false
        var aoqRuntime = false
        if let raw = value["media"] {
            guard let media = raw as? [String: Any], let selected = media["pipeline"] as? String,
                  ["integrated", "cascaded"].contains(selected) else { throw WireError("不兼容的语音模式") }
            if media["transport"] as? String == "qwen_aoq_chat_v1" {
                guard allowAOQ, selected == "integrated", media["path"] as? String == "direct",
                      media["audio_owner"] as? String == "aoq_sdk", media["mode"] as? String == "chat_only",
                      !capabilities.contains("executor"), !capabilities.contains("projects") else { throw WireError("AOQ 仅支持实验聊天模式") }
                aoqChat = true
            } else if media["transport"] as? String == "qwen_aoq_runtime_v1" {
                guard allowAOQRuntime, selected == "integrated", media["path"] as? String == "direct",
                      media["audio_owner"] as? String == "aoq_sdk", media["mode"] as? String == "runtime",
                      Set(["audio", "captions", "projects", "executor"]).isSubset(of: Set(capabilities)) else { throw WireError("AOQ Runtime 握手不兼容") }
                aoqChat = true; aoqRuntime = true
            } else {
                guard media["transport"] as? String == "host_pcm_v1", media["path"] as? String == "relay",
                      media["audio_owner"] as? String == "client" else { throw WireError("不兼容的语音接入路径") }
            }
            pipeline = selected
        }
        if !aoqChat && !Set(["projects", "executor"]).isSubset(of: Set(capabilities)) { throw WireError("Incompatible server handshake") }
        return Ready(instance: instance, connection: connection, pipeline: pipeline, editableInput: pipeline == "cascaded" && Set(["text_input", "dictation"]).isSubset(of: Set(capabilities)), aoqChat: aoqChat, aoqRuntime: aoqRuntime)
    }
    static func receiveFailureCode(_ error: Error, ready: Bool, serverCode: Int) -> Int {
        if serverCode != 0 { return serverCode } // A real server close takes precedence.
        if error is WireError { return ready ? 1002 : 4006 }
        return 1006
    }
    static var renderMS: Double { ProcessInfo.processInfo.systemUptime * 1000 }
}
import CoreFoundation


struct ConnectionRecovery {
    private var attempts = 0
    private var readyAtMS: Double?
    mutating func markReady(atMS now: Double) { readyAtMS = now }
    mutating func nextDelay(atMS now: Double) -> Int? {
        // A handshake alone is not recovery: ready -> malformed must exhaust its budget.
        if let readyAtMS, now - readyAtMS >= 30_000 { attempts = 0 }
        readyAtMS = nil
        guard attempts < 3 else { return nil }
        let delay = 1 << attempts
        attempts += 1
        return delay
    }
}
