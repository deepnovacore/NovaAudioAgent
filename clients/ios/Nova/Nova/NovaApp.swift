import SwiftUI
import AVFoundation
@main struct NovaApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--check-capture") {
                Text("正在检查麦克风 · 不保存录音").task { await checkCapture() }
            } else { ContentView() }
            #else
            ContentView()
            #endif
        }
    }
    #if DEBUG
    @MainActor private func checkCapture() async {
        guard await AVAudioApplication.requestRecordPermission() else { print("[capture-check] permission denied"); return }
        let audio = VoiceAudio()
        var frames = 0
        audio.onPCM = { _ in frames += 1 }
        do {
            try audio.start(threshold: 0.045)
            try await Task.sleep(for: .seconds(5))
            audio.stop()
            print("[capture-check] frames=\(frames) result=\(frames > 0 ? "PASS" : "FAIL")")
        } catch { audio.stop(); print("[capture-check] failed \(error)") }
    }
    #endif
}
