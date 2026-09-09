import Foundation
import CryptoKit
import Security

enum EnterpriseSSO {
    // A deployment opts in; the public client never ships an organization endpoint.
    static func origin(_ value: String) throws -> String {
        guard let url = URLComponents(string: value), url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              ["", "/"].contains(url.percentEncodedPath) else { throw WireError("登录服务必须是 HTTPS 站点地址。") }
        return "https://" + host
    }
    static var configuredOrigin: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "NovaFeishuLoginOrigin") as? String else { return nil }
        return try? origin(value)
    }
    struct Attempt {
        let origin: String
        let state: String
        let verifier: String
        init(origin: String) throws { self.origin = try EnterpriseSSO.origin(origin); state = try EnterpriseSSO.random(); verifier = try EnterpriseSSO.random() }
        var startURL: URL {
            var url = URLComponents(string: origin + "/auth/nova/start")!
            url.queryItems = [URLQueryItem(name: "state", value: state),
                              URLQueryItem(name: "code_challenge", value: EnterpriseSSO.challenge(verifier))]
            return url.url!
        }
    }
    struct Credential: Decodable {
        let server: String
        let token: String
        let expires_at: Int64
        var expiresAt: Date { Date(timeIntervalSince1970: Double(expires_at) / 1000) }
    }
    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw WireError("无法安全启动飞书登录，请重试。")
        }
        return base64url(Data(bytes))
    }
    static func challenge(_ verifier: String) -> String { base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    static func callback(_ url: URL, state: String) throws -> String {
        guard url.absoluteString.utf8.count <= 2048,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "nova-sso", parts.host == "callback", parts.user == nil, parts.password == nil,
              parts.port == nil, parts.fragment == nil, ["", "/"].contains(parts.percentEncodedPath),
              let items = parts.queryItems, items.count == 2,
              items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state else {
            throw WireError("飞书登录回调无效，请重新登录。")
        }
        if items.contains(where: { $0.name == "error" }) { throw WireError("飞书登录未完成，请重试。") }
        guard let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw WireError("飞书登录授权码无效，请重试。")
        }
        return code
    }
    static func credential(_ data: Data, origin: String, now: Date = Date()) throws -> Credential {
        guard data.count <= 4096 else { throw WireError("飞书登录响应过大。") }
        let value = try JSONDecoder().decode(Credential.self, from: data)
        guard value.server == "wss://" + (try Self.origin(origin)).dropFirst(8) + "/client/v1",
              value.token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
              value.expiresAt > now else { throw WireError("飞书登录凭据无效或已过期，请重试。") }
        return value
    }
}


// Never forward the one-time code or verifier through an HTTP redirect.
final class EnterpriseHTTP: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    // A VPN path notification can precede usable DNS/routes. Retry only this read-only probe.
    static func health(origin: String, session: URLSession, retryDelay: Duration = .seconds(1)) async throws -> Bool {
        for attempt in 0..<3 {
            try Task.checkCancellation()
            do {
                var request = URLRequest(url: URL(string: try EnterpriseSSO.origin(origin) + "/nova/health")!, timeoutInterval: 5)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                let response = try await data(for: request, session: session, limit: 1024)
                struct Health: Decodable { let available: Bool }
                return try JSONDecoder().decode(Health.self, from: response).available
            } catch {
                try Task.checkCancellation()
                if attempt == 2 { throw error }
                try await Task.sleep(for: retryDelay)
            }
        }
        return false
    }

    static func data(for request: URLRequest, session: URLSession, limit: Int) async throws -> Data {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              response.expectedContentLength <= Int64(limit) else { throw WireError("企业登录服务响应无效。") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < limit else { throw WireError("企业登录服务响应过大。") }
            data.append(byte)
        }
        return data
    }
}
