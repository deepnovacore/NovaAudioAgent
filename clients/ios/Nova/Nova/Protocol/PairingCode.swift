import Foundation

struct PairingCode: Identifiable {
    let server: URL
    let code: String
    let expiresAt: Date
    var id: String { code }
    var endpoint: URL {
        var parts = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        parts.path = "/client/pair"
        return parts.url!
    }
    static func parse(_ text: String, now: Date = Date()) throws -> PairingCode {
        struct Payload: Decodable {
            let type: String
            let version: Int
            let server: String
            let code: String
            let expires_at: Double
        }
        guard text.utf8.count <= 4096,
              let payload = try? JSONDecoder().decode(Payload.self, from: Data(text.utf8)),
              payload.type == "nova.pair", payload.version == 1,
              payload.code.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
              payload.expires_at.isFinite else { throw WireError("这不是有效的 Nova 配对二维码。") }
        let expires = Date(timeIntervalSince1970: payload.expires_at / 1000)
        guard expires > now else { throw WireError("二维码已过期，请在 Mac 上重新生成。") }
        return try PairingCode(server: Wire.endpoint(payload.server), code: payload.code, expiresAt: expires)
    }
}
