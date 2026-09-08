import AppKit
import CoreImage.CIFilterBuiltins

struct Configuration: Decodable { let port: Int; let token: String; let server: String }

func qrImage(_ data: Data) throws -> CGImage {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = data
    filter.correctionLevel = "M"
    guard let output = filter.outputImage,
          let image = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 6, y: 6)),
                                               from: output.extent.applying(CGAffineTransform(scaleX: 6, y: 6))) else {
        throw NSError(domain: "pairing", code: 1)
    }
    return image
}

@MainActor final class PairingWindow: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let config: Configuration
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 650),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    let image = NSImageView()
    let status = NSTextField(wrappingLabelWithString: "正在生成二维码…")
    let devices = NSStackView()
    let refresh = NSButton(title: "重新生成二维码", target: nil, action: nil)
    var code: String?
    var expires = Date.distantPast
    var timer: Timer?
    var busy = false
    var closing = false
    var polling = false
    var ticks = 0
    init(config: Configuration) { self.config = config; super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Nova · 连接手机"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let root = NSStackView()
        root.orientation = .vertical; root.spacing = 14
        root.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        let title = NSTextField(labelWithString: "用 Nova iOS 扫码连接")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        root.addArrangedSubview(title)
        let host = NSTextField(wrappingLabelWithString: config.server)
        host.alignment = .center; host.isSelectable = true
        root.addArrangedSubview(host)
        image.imageScaling = .scaleProportionallyUpOrDown
        image.setAccessibilityLabel("Nova 一次性配对二维码")
        // White quiet zone is part of the view, independent of macOS appearance.
        image.wantsLayer = true; image.layer?.backgroundColor = NSColor.white.cgColor
        image.widthAnchor.constraint(equalToConstant: 292).isActive = true
        image.heightAnchor.constraint(equalToConstant: 292).isActive = true
        root.addArrangedSubview(image)
        status.alignment = .center; root.addArrangedSubview(status)
        refresh.target = self; refresh.action = #selector(regenerate)
        root.addArrangedSubview(refresh)
        let heading = NSTextField(labelWithString: "已配对设备")
        heading.font = .systemFont(ofSize: 14, weight: .semibold)
        root.addArrangedSubview(heading)
        devices.orientation = .vertical; devices.spacing = 8
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.documentView = devices
        devices.translatesAutoresizingMaskIntoConstraints = false
        devices.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor).isActive = true
        devices.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor).isActive = true
        devices.topAnchor.constraint(equalTo: scroll.contentView.topAnchor).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 110).isActive = true
        scroll.widthAnchor.constraint(equalToConstant: 400).isActive = true
        root.addArrangedSubview(scroll)
        window.contentView = root
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        regenerate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func request(_ payload: [String: Any]) async throws -> [String: Any] {
        var frame = payload; frame["token"] = config.token
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: URL(string: "ws://127.0.0.1:\(config.port)/client/pair-admin")!)
        socket.maximumMessageSize = 16384
        let timeout = Task {
            try? await Task.sleep(for: .seconds(8))
            if !Task.isCancelled { socket.cancel(with: .goingAway, reason: nil) }
        }
        defer { timeout.cancel(); session.invalidateAndCancel() }
        socket.resume()
        try await socket.send(.string(String(decoding: JSONSerialization.data(withJSONObject: frame), as: UTF8.self)))
        let message = try await socket.receive()
        let bytes: Data
        switch message {
        case .string(let text): bytes = Data(text.utf8)
        case .data(let data): bytes = data
        @unknown default: throw NSError(domain: "pairing", code: 2)
        }
        guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              result["type"] as? String != "pair.error" else { throw NSError(domain: "pairing", code: 3) }
        return result
    }

    @objc func regenerate() {
        guard !busy, !closing else { return }
        busy = true; refresh.isEnabled = false; image.image = nil; status.stringValue = "正在生成二维码…"
        Task {
            do {
                let qr = try await request(["type": "pair.create", "server": config.server])
                guard let nextCode = qr["code"] as? String, let deadline = qr["expires_at"] as? Double else {
                    throw NSError(domain: "pairing", code: 4)
                }
                code = nextCode; expires = Date(timeIntervalSince1970: deadline / 1000)
                if closing {
                    _ = try? await request(["type": "pair.cancel", "code": nextCode]); return
                }
                let cg = try qrImage(JSONSerialization.data(withJSONObject: qr, options: [.sortedKeys]))
                // Bake a four-module quiet zone around the generated code.
                let size = NSSize(width: cg.width + 48, height: cg.height + 48)
                let framed = NSImage(size: size)
                framed.lockFocus()
                NSColor.white.setFill(); NSRect(origin: .zero, size: size).fill()
                NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
                    .draw(at: NSPoint(x: 24, y: 24), from: .zero, operation: .copy, fraction: 1)
                framed.unlockFocus(); image.image = framed
                try await reloadDevices()
            } catch { status.stringValue = "无法配对：请检查服务、环境配置或设备数量（最多 32 台）。" }
            busy = false; refresh.isEnabled = true
            if image.image != nil { tick() }
        }
    }

    func tick() {
        guard !busy, code != nil else { return }
        ticks += 1
        if ticks % 3 == 0 && !polling {
            polling = true
            Task {
                defer { polling = false }
                try? await reloadDevices()
            }
        }
        let seconds = max(0, Int(ceil(expires.timeIntervalSinceNow)))
        if seconds == 0 { image.image = nil; code = nil; status.stringValue = "二维码已过期，请重新生成。" }
        else if image.image != nil { status.stringValue = "\(seconds) 秒内有效 · 仅可使用一次" }
    }

    func reloadDevices() async throws {
        let checkedCode = code
        var frame: [String: Any] = ["type": "pair.list"]
        if let checkedCode { frame["code"] = checkedCode }
        let response = try await request(frame)
        if let checkedCode, code == checkedCode, response["pairing_active"] as? Bool == false {
            code = nil; image.image = nil
            status.stringValue = "二维码已使用或失效。连接其他设备请重新生成。"
        }
        for view in devices.arrangedSubviews { devices.removeArrangedSubview(view); view.removeFromSuperview() }
        let rows = response["devices"] as? [[String: Any]] ?? []
        for row in rows {
            guard let id = row["id"] as? String, let name = row["name"] as? String else { continue }
            let label = NSTextField(labelWithString: name)
            label.lineBreakMode = .byTruncatingTail
            let remove = NSButton(title: "撤销连接", target: self, action: #selector(revoke(_:)))
            remove.identifier = NSUserInterfaceItemIdentifier(id)
            let stack = NSStackView(views: [label, remove])
            stack.distribution = .fill; devices.addArrangedSubview(stack)
        }
        let reload = NSButton(title: "刷新设备列表", target: self, action: #selector(reload))
        devices.addArrangedSubview(reload)
    }

    @objc func reload() {
        Task { do { try await reloadDevices() } catch { status.stringValue = "设备列表刷新失败，请检查服务。" } }
    }
    @objc func revoke(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        let alert = NSAlert()
        alert.messageText = "撤销这台设备的连接？"
        alert.informativeText = "当前连接将断开，再次连接需要重新扫码。"
        alert.addButton(withTitle: "撤销"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        sender.isEnabled = false
        Task {
            do { _ = try await request(["type": "pair.revoke", "device_id": id]); try await reloadDevices() }
            catch { sender.isEnabled = true; status.stringValue = "撤销失败，请检查服务后重试。" }
        }
    }
    func windowWillClose(_ notification: Notification) {
        closing = true; timer?.invalidate(); image.image = nil
        Task {
            if let code { _ = try? await request(["type": "pair.cancel", "code": code]) }
            NSApplication.shared.terminate(nil)
        }
    }
}

if CommandLine.arguments.contains("--check") {
    let payload = Data(#"{"type":"nova.pair","version":1,"server":"wss://mac.example/client/v1","code":"0123456789abcdef0123456789abcdef","expires_at":9999999999999}"#.utf8)
    let cg = try qrImage(payload)
    let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
    let result = detector.features(in: CIImage(cgImage: cg)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
    precondition(result == [String(decoding: payload, as: UTF8.self)])
    print("QR encode/decode PASS")
} else {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let config = try? JSONDecoder().decode(Configuration.self, from: input),
          (1...65535).contains(config.port), config.token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else {
        fputs("Invalid pairing configuration\n", stderr); exit(1)
    }
    MainActor.assumeIsolated {
    let application = NSApplication.shared
    application.setActivationPolicy(.regular)
    let delegate = PairingWindow(config: config)
    application.delegate = delegate
    application.run()
    }
}
