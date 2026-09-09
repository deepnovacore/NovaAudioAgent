import SwiftUI
import UIKit

struct ContentView: View {
    @StateObject private var client = Client()
    @StateObject private var enterprise = EnterpriseLogin()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dictationPressed = false
    @State private var settings = false
    @State private var scanning = false
    @State private var invitation: PairingCode?
    @State private var confirmPairing = false
    @State private var scanError = ""
    @State private var showScanError = false
    private let mint = Color(red: 0.58, green: 0.92, blue: 0.85)
    private let ink = Color(red: 0.035, green: 0.055, blue: 0.08)

    private var stateLabel: String {
        if client.connecting { return "正在连接" }
        if !client.connected { return "尚未连接" }
        if client.muted { return "麦克风已静音" }
        return client.voice ? "正在聆听" : "已连接"
    }
    var body: some View {
        personalBody
        .preferredColorScheme(.dark).tint(mint)
        .sheet(isPresented: $settings, onDismiss: { enterprise.cancel() }) { connectionSettings }
        .onChange(of: client.connectionRevision) { _, _ in enterprise.cancel() }
        .onChange(of: client.server) { _, _ in enterprise.cancel() }
        .onChange(of: client.token) { _, _ in enterprise.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { enterprise.foreground() }; if phase != .active { dictationPressed = false; client.cancelDictation() }; if phase == .background { scanning = false; invitation = nil; confirmPairing = false; if client.pairing { client.end() } }; if phase == .background || (phase == .inactive && client.voice) { client.suspendAudio() } }
        .onChange(of: client.status) { _, status in
            if UIAccessibility.isVoiceOverRunning { UIAccessibility.post(notification: .announcement, argument: status) }
        }
    }
    private var personalBody: some View {
        ZStack {
            ink.ignoresSafeArea()
            RadialGradient(colors: [mint.opacity(0.085), .clear], center: .topTrailing,
                           startRadius: 0, endRadius: 500).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 28) {
                    header
                    hero
                    if !client.captions.isEmpty { conversation }
                    if !client.approvals.isEmpty { decisions }
                    if client.connected && (!client.taskStates.isEmpty || !client.results.isEmpty) { work }
                }.padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 24)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { controls }
        }
    }
    private var header: some View {
        HStack {
            Text("Nova").font(.system(.title3, design: .rounded).weight(.semibold)).tracking(-0.6)
            Spacer()
            Button { settings = true } label: {
                HStack(spacing: 7) {
                    Circle().fill(client.connected ? mint : .white.opacity(0.35)).frame(width: 6, height: 6)
                    Image(systemName: "slider.horizontal.3").font(.caption)
                }.foregroundStyle(.white.opacity(0.8)).padding(.horizontal, 14).frame(minHeight: 44)
                    .background(.white.opacity(0.055), in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.09)))
            }.accessibilityLabel("连接设置，\(stateLabel)")
        }
    }
    private var hero: some View {
        VStack(spacing: 14) {
            NovaStarfield(listening: client.voice && !client.muted, level: client.inputLevel)
                .frame(height: 248).accessibilityHidden(true)
            HStack(spacing: 7) {
                if client.connecting { ProgressView().controlSize(.mini) }
                Text(client.status)
                    .font(.subheadline).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("connection-status")
            }.foregroundStyle(client.connected ? mint : .white.opacity(0.5))
        }
    }
    private var conversation: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let user = client.captions["user"], !user.isEmpty {
                Text(user).font(.subheadline).foregroundStyle(.white.opacity(0.6))
                    .textSelection(.enabled).accessibilityLabel("你：\(user)")
                if client.captions["assistant"]?.isEmpty == false {
                    Rectangle().fill(.white.opacity(0.08)).frame(height: 1)
                }
            }
            if let assistant = client.captions["assistant"], !assistant.isEmpty {
                Text(assistant).font(.body).lineSpacing(6).foregroundStyle(.white.opacity(0.88))
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Nova：\(assistant)")
            }
            if client.connected && client.project != "No project" && client.project != "Waiting for host state" && !client.project.isEmpty {
                Label(client.project, systemImage: "folder").font(.caption).foregroundStyle(mint.opacity(0.8))
            }
        }.padding(22).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.065)))
    }
    private var controls: some View {
        VStack(spacing: 14) {
            if client.editableInput && !client.voice && !client.voiceStarting { inputComposer }
            if client.voice || client.voiceStarting {
                HStack(spacing: 24) {
                    audioButton(client.muted ? "取消静音" : "静音", icon: client.muted ? "mic.slash.fill" : "mic.fill", active: client.muted) { client.toggleMute() }
                    Button { client.suspendAudio() } label: {
                        Image(systemName: "phone.down.fill").font(.title2).foregroundStyle(.white)
                            .frame(width: 74, height: 62).background(Color(red: 0.76, green: 0.28, blue: 0.30), in: Capsule())
                    }.accessibilityLabel("结束通话")
                    audioButton("扬声器", icon: "speaker.wave.2.fill", active: client.speaker) { client.toggleSpeaker() }
                }.frame(maxWidth: .infinity)
            } else {
                Button {
                    if client.connected { Task { await client.startVoice() } }
                    else if client.server.isEmpty || client.token.isEmpty { settings = true }
                    else { client.connect() }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: client.connected ? "mic.fill" : "link")
                        Text(client.connected ? "开始对话" : "连接").fontWeight(.semibold)
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.subheadline)
                    }.padding(.horizontal, 24).frame(minHeight: 58)
                        .foregroundStyle(ink).background(mint, in: Capsule())
                }.disabled(client.connecting || client.dictationRecording || client.dictationTranscribing || client.textSending).opacity(client.connecting ? 0.5 : 1)
                    .accessibilityIdentifier(client.connected ? "start-voice" : "connect")
            }
        }.padding(.horizontal, 28).padding(.top, 20).padding(.bottom, 14)
            .background(LinearGradient(colors: [ink.opacity(0), ink, ink], startPoint: .top, endPoint: .bottom))
    }
    private var inputComposer: some View {
        VStack(spacing: 10) {
            TextField("输入消息…", text: $client.inputDraft, axis: .vertical)
                .lineLimit(1...5).padding(12)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
                .disabled(client.dictationRecording || client.dictationTranscribing)
            HStack {
                Text(client.dictationRecording ? "松开转文字" : "按住说话")
                    .frame(maxWidth: .infinity).frame(minHeight: 44)
                    .background(mint.opacity(client.dictationRecording ? 0.25 : 0.08), in: Capsule())
                    .contentShape(Capsule())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { _ in if !dictationPressed { dictationPressed = true; client.beginDictation() } }
                        .onEnded { _ in dictationPressed = false; client.finishDictation() })
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { if client.dictationRecording { client.finishDictation() } else { client.beginDictation() } }
                    .accessibilityLabel(client.dictationRecording ? "结束录音并识别" : "开始语音识别")
                if client.dictationRecording || client.dictationTranscribing {
                    Button("取消") { client.cancelDictation() }.frame(minHeight: 44)
                } else {
                    Button { client.sendDraft() } label: { Image(systemName: "arrow.up").frame(width: 44, height: 44).background(mint, in: Circle()).foregroundStyle(ink) }
                        .accessibilityLabel("发送消息")
                        .disabled(client.textSending || client.inputDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || client.inputDraft.utf16.count > 4000)
                }
            }
            if client.dictationTranscribing { ProgressView("正在识别…") }
            if !client.inputNotice.isEmpty { Text(client.inputNotice).font(.caption).foregroundStyle(.secondary) }
            if client.inputDraft.utf16.count > 4000 { Text("消息过长，请缩短后发送").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func audioButton(_ title: String, icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: icon).font(.body).frame(width: 48, height: 44)
                    .background(active ? mint.opacity(0.18) : .white.opacity(0.07), in: Capsule())
                Text(title).font(.caption2)
            }.foregroundStyle(active ? mint : .white.opacity(0.7))
        }.accessibilityLabel(title).accessibilityAddTraits(active ? .isSelected : []).disabled(client.voiceStarting)
    }
    private var decisions: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("需要你确认", systemImage: "hand.raised").font(.headline).foregroundStyle(mint)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ForEach(client.approvals) { card in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(card.project).font(.caption).foregroundStyle(.secondary)
                        Text(card.title).font(.headline)
                        Text(card.detail).font(.subheadline).textSelection(.enabled)
                        Text(card.busy ? "正在等待 Mac" : card.deadline.map { $0 > context.date ? "\(max(0, Int($0.timeIntervalSince(context.date)))) 秒内有效" : "已过期，等待更新" } ?? "等待 Mac 更新")
                            .font(.caption).foregroundStyle(.secondary)
                        if client.submitted.contains(card.id) { Text("已提交，等待 Mac 确认").font(.caption).foregroundStyle(mint) }
                        ForEach(card.decisions, id: \.self) { decision in
                            Button(decision == "decline" ? "拒绝" : decision == "acceptForSession" ? "本次会话允许" : "允许",
                                   role: decision == "decline" ? .destructive : nil) { client.decide(card, decision: decision) }
                                .buttonStyle(.bordered).frame(minHeight: 44)
                                .disabled(!card.actionable(at: context.date) || client.submitted.contains(card.id))
                        }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 20))
                }
            }
            if !client.commandStatus.isEmpty { Text(client.commandStatus).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var work: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("任务", systemImage: "desktopcomputer").font(.headline)
            ForEach(client.taskStates.keys.sorted(), id: \.self) { key in
                VStack(alignment: .leading, spacing: 5) {
                    Text(key).font(.caption).foregroundStyle(.secondary)
                    Text(client.taskStates[key] ?? "").font(.subheadline)
                }
            }
            ForEach(client.results.keys.sorted(), id: \.self) { key in
                Text(client.results[key] ?? "").font(.body).lineSpacing(4).textSelection(.enabled)
            }
        }.padding(22).frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 24))
    }
    private var connectionSettings: some View {
        NavigationStack {
            Form {
                Section {
                    if enterprise.busy {
                        ProgressView(enterprise.status)
                        Button("取消飞书登录", role: .cancel) { enterprise.cancel() }
                    } else {
                        Button("飞书登录") {
                            let revision = client.connectionRevision
                            enterprise.start { credential in
                                guard client.connectionRevision == revision, !client.connected, !client.connecting else { return }
                                client.connectFeishu(credential)
                                if client.connecting { settings = false }
                            }
                        }.disabled(!enterprise.available || client.connected || client.connecting)
                            .accessibilityIdentifier("feishu-login")
                    }
                    if !enterprise.status.isEmpty { Text(enterprise.status).font(.caption) }
                } footer: { Text("由部署方配置登录服务后启用。") }
                Section {
                    Button { enterprise.cancel(); scanning = true } label: { Label("扫码连接主机", systemImage: "qrcode.viewfinder") }
                        .disabled(client.connected || client.connecting)
                        .accessibilityIdentifier("scan-to-connect")
                } footer: { Text("扫描 Mac 上的 Nova 二维码，自动填入地址并安全保存连接凭据。") }
                Section {
                    TextField("wss://你的 Mac.ts.net", text: $client.server)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .onSubmit { client.loadCredential() }
                    SecureField("连接密钥", text: $client.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("语音接入", selection: $client.mediaPreference) {
                        Text("跟随主机").tag("auto")
                        Text("主机中转").tag("relay")
                        if Client.aoqAvailable { Text("AOQ").tag("aoq") }
                    }.disabled(client.connected || client.connecting)
                } header: { Text("手动连接") } footer: { Text("填写 Mac 的私网地址与连接密钥。密钥仅保存在这台 iPhone 的钥匙串中。") }
                    .disabled(client.connected || client.connecting)
                if client.connected || client.connecting {
                    Section { Button("断开连接", role: .destructive) { client.end() } }
                }
                Section {
                    Slider(value: $client.speechThreshold, in: 0.01...0.15).accessibilityLabel("语音检测阈值")
                    Text("环境嘈杂时调高；轻声说话时调低。当前阈值 \(client.speechThreshold, specifier: "%.3f")。")
                        .font(.caption).foregroundStyle(.secondary)
                } header: { Text("语音检测") }
                #if DEBUG
                Section("开发选项") {
                    Toggle("允许本机 ws 连接", isOn: $client.debugLocalhost).disabled(client.connected || client.connecting)
                }
                #endif
            }.navigationTitle("连接设置").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { enterprise.cancel(); settings = false } } }
            .sheet(isPresented: $scanning, onDismiss: {
                if invitation != nil { confirmPairing = true }
                else if !scanError.isEmpty { showScanError = true }
            }) {
                PairingScanner { text in
                    do { invitation = try PairingCode.parse(text); scanError = "" }
                    catch { invitation = nil; scanError = error.localizedDescription }
                    scanning = false
                }
            }
            .alert("连接这台主机？", isPresented: $confirmPairing) {
                Button("取消", role: .cancel) { invitation = nil }
                Button("连接") {
                    if let invitation { client.pair(invitation) }
                    invitation = nil
                }
            } message: { Text(invitation?.server.absoluteString ?? "") }
            .alert("无法使用二维码", isPresented: $showScanError) {
                Button("好") { scanError = "" }
            } message: { Text(scanError) }
        }.preferredColorScheme(.dark).tint(mint).presentationDragIndicator(.visible)
            .onAppear { enterprise.refresh() }
    }
}


// Mirrors desktop orb's layered nebula and inward listening pulse, using native Canvas.
private struct NovaStarfield: View {
    let listening: Bool
    let level: Float
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    private let mint = Color(red: 0.58, green: 0.92, blue: 0.85)
    @State private var animationStart = ProcessInfo.processInfo.systemUptime
    @State private var animationElapsed: TimeInterval = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || scenePhase != .active)) { timeline in
            let time = reduceMotion ? 0 : animationElapsed + (scenePhase == .active ? ProcessInfo.processInfo.systemUptime - animationStart : 0)
            let amplitude = reduceMotion || !listening ? 0 : min(1, Double(level) * 1.4)
            ZStack {
                Circle().fill(RadialGradient(colors: [mint.opacity(0.20), Color(red: 0.08, green: 0.12, blue: 0.24).opacity(0.6), .clear],
                    center: .center, startRadius: 0, endRadius: 119)).frame(width: 238, height: 238)
                Circle().strokeBorder(mint.opacity(0.09), lineWidth: 0.5).frame(width: 226, height: 226)
                Canvas { context, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    context.blendMode = .plusLighter
                    for index in 0..<520 {
                        let seed = Double(index)
                        let fraction = (seed * 0.61803398875).truncatingRemainder(dividingBy: 1)
                        let radius = (12 + sqrt(fraction) * 94) * (1 + amplitude * 0.035 * sin(time * 1.8 + seed * 0.13))
                        let angle = seed * 2.399963 + time * (0.055 + fraction * 0.045)
                        let depth = sin(seed * 1.73)
                        let x = center.x + cos(angle) * radius
                        let y = center.y + sin(angle) * radius * (0.78 + depth * 0.16)
                        let pointSize = (index % 29 == 0 ? 2.6 : (index % 7 == 0 ? 1.6 : 0.85)) * (1 + amplitude * 0.12)
                        let shimmer = 0.65 + 0.35 * sin(time * 0.7 + seed)
                        let opacity = (0.3 + 0.5 * (1 - fraction)) * shimmer + amplitude * 0.10
                        let color: Color = index % 7 == 0 ? Color(red: 1, green: 0.83, blue: 0.58) : (index % 3 == 0 ? .white : mint)
                        let rect = CGRect(x: x - pointSize / 2, y: y - pointSize / 2, width: pointSize, height: pointSize)
                        context.fill(Path(ellipseIn: rect), with: .color(color.opacity(opacity)))
                        if index % 29 == 0 {
                            context.fill(Path(ellipseIn: rect.insetBy(dx: -2, dy: -2)), with: .color(color.opacity(opacity * 0.10)))
                        }
                    }
                }.frame(width: 238, height: 238)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.onChange(of: scenePhase) { old, new in
            let now = ProcessInfo.processInfo.systemUptime
            if old == .active { animationElapsed += now - animationStart }
            if new == .active { animationStart = now }
        }
    }
}
