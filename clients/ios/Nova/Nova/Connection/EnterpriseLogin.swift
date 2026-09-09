import AuthenticationServices
import Network
import SwiftUI

@MainActor final class EnterpriseLogin: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published private(set) var available = false
    @Published private(set) var checking = false
    @Published private(set) var busy = false
    @Published private(set) var status = ""
    private let origin = EnterpriseSSO.configuredOrigin
    private let monitor = NWPathMonitor()
    private let session: URLSession
    private let exchangeSession: URLSession
    private var probe: Task<Void, Never>?
    private var probeID = UUID()
    private var loginID = UUID()
    private var web: ASWebAuthenticationSession?
    private var exchange: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var anchor: ASPresentationAnchor?
    private var pending: EnterpriseSSO.Credential?
    private var completion: ((EnterpriseSSO.Credential) -> Void)?

    override init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5; config.timeoutIntervalForResource = 10
        config.httpCookieStorage = nil; config.urlCache = nil
        session = URLSession(configuration: config, delegate: EnterpriseHTTP(), delegateQueue: nil)
        config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 60
        exchangeSession = URLSession(configuration: config, delegate: EnterpriseHTTP(), delegateQueue: nil)
        super.init()
        monitor.pathUpdateHandler = { [weak self] _ in Task { @MainActor in self?.refresh() } }
        monitor.start(queue: DispatchQueue(label: "nova.enterprise.network"))
    }
    deinit { monitor.cancel(); probe?.cancel(); exchange?.cancel(); expiry?.cancel(); session.invalidateAndCancel(); exchangeSession.invalidateAndCancel() }
    func refresh() {
        guard let origin else { available = false; status = "此构建尚未配置飞书登录服务"; return }
        probe?.cancel(); let id = UUID(); probeID = id; checking = true
        probe = Task { [weak self] in
            guard let self else { return }
            do {
                let healthy = try await EnterpriseHTTP.health(origin: origin, session: self.session)
                guard self.probeID == id, !Task.isCancelled else { return }
                self.available = healthy; self.checking = false
            } catch { if self.probeID == id, !Task.isCancelled { self.available = false; self.checking = false } }
        }
    }
    func foreground() { refresh(); deliverIfActive() }
    func cancel() {
        loginID = UUID(); web?.cancel(); web = nil; exchange?.cancel(); exchange = nil
        expiry?.cancel(); expiry = nil; pending = nil; completion = nil; anchor = nil; busy = false; status = ""
    }
    func start(completion: @escaping (EnterpriseSSO.Credential) -> Void) {
        cancel()
        guard let origin, available, UIApplication.shared.applicationState == .active,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .filter({ $0.activationState == .foregroundActive }).flatMap({ $0.windows }).first(where: { $0.isKeyWindow }) else { return }
        do {
            let attempt = try EnterpriseSSO.Attempt(origin: origin)
            let id = loginID
            self.completion = completion; anchor = window; busy = true; status = "正在等待飞书登录"
            let web = ASWebAuthenticationSession(url: attempt.startURL, callbackURLScheme: "nova-sso") { [weak self] url, error in
                Task { @MainActor in
                    guard let self, self.loginID == id, self.busy else { return }
                    self.web = nil
                    guard let url, error == nil else {
                        self.cancel(); self.status = "飞书登录已取消"; return
                    }
                    do { self.redeem(try EnterpriseSSO.callback(url, state: attempt.state), verifier: attempt.verifier, id: id) }
                    catch { self.cancel(); self.status = "飞书登录回调无效，请重试。" }
                }
            }
            web.presentationContextProvider = self
            self.web = web
            guard web.start() else { cancel(); status = "无法打开飞书登录，请重试。"; return }
            expiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled, let self, self.loginID == id else { return }
                self.cancel(); self.status = "飞书登录超时，请重试。"
            }
        } catch { cancel(); status = error.localizedDescription }
    }
    private func redeem(_ code: String, verifier: String, id: UUID) {
        guard let origin else { return }
        status = "正在完成飞书登录"
        exchange = Task { [weak self] in
            guard let self else { return }
            do {
                var request = URLRequest(url: URL(string: origin + "/nova/exchange")!, timeoutInterval: 60)
                request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "code_verifier": verifier,
                    "device_name": String(UIDevice.current.name.prefix(80))])
                let data = try await EnterpriseHTTP.data(for: request, session: self.exchangeSession, limit: 4096)
                guard self.loginID == id, !Task.isCancelled else { return }
                self.pending = try EnterpriseSSO.credential(data, origin: origin)
                self.deliverIfActive()
            } catch {
                guard self.loginID == id, !Task.isCancelled else { return }
                self.cancel(); self.status = "飞书登录失败，请检查网络后重试。"
            }
        }
    }
    private func deliverIfActive() {
        guard UIApplication.shared.applicationState == .active, let pending, let completion else { return }
        guard pending.expiresAt > Date() else { cancel(); status = "飞书登录已过期，请重试。"; return }
        // Clear ownership before Client.connect changes the connection revision.
        cancel(); completion(pending)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { anchor ?? ASPresentationAnchor() }
}
