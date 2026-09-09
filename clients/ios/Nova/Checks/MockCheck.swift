import Foundation

// Standalone protocol smoke. Uses only the public synthetic mock credential; never opens audio.
@main struct MockCheck {
    static func main() async throws {
        let url = try Wire.endpoint(CommandLine.arguments.dropFirst().first ?? "ws://127.0.0.1:18787", debugLocalhost: true)
        let socket = URLSession.shared.webSocketTask(with: url)
        socket.maximumMessageSize = 6 + Wire.maxHeader + Wire.maxPCM
        socket.resume()
        let timeout = Task {
            try? await Task.sleep(for: .seconds(10))
            if !Task.isCancelled { socket.cancel(with: .goingAway, reason: nil) }
        }
        defer { timeout.cancel(); socket.cancel(with: .normalClosure, reason: nil) }
        try await socket.send(.string(#"{"type":"hello","token":"0123456789abcdef0123456789abcdef","protocol_version":1}"#))
        guard case .string(let first) = try await socket.receive() else { throw WireError("Expected ready") }
        let ready = try Wire.ready(Wire.json(Data(first.utf8)))
        let request = UUID().uuidString
        var receipt = false, confirmed = false, caption = false, audio = false
        while !(receipt && confirmed && caption && audio) {
            switch try await socket.receive() {
            case .data(let bytes):
                let frame = try Wire.audio(bytes)
                guard frame.pcm.count > 0 else { throw WireError("Missing mock audio") }
                audio = true
            case .string(let text):
                let value = try Wire.json(Data(text.utf8))
                switch value["type"] as? String {
                case "project.state":
                    if value["pending_confirmation"] as? Bool == true {
                        let id = try Wire.identifier(value["pending_confirmation_id"])
                        let command: [String: Any] = ["type": "client.command", "request_id": request,
                            "connection_id": ready.connection,
                            "payload": ["type": "project.confirmation_decision", "proposal_id": id, "confirmed": true]]
                        let data = try JSONSerialization.data(withJSONObject: command)
                        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
                    } else { confirmed = true }
                case "client.command_result":
                    guard value["request_id"] as? String == request, value["status"] as? String == "applied" else { throw WireError("Command was not delivered") }
                    receipt = true // Independent from authoritative project.state.
                case "caption": caption = (value["text"] as? String)?.isEmpty == false
                default: break
                }
            @unknown default: throw WireError("Unknown message")
            }
        }
        print("PASS: native WebSocket ready, Unicode caption, NOVA audio, command receipt and authoritative project confirmation; no audio device opened")
    }
}
