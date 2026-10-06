// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "NovaAudioCore", platforms: [.macOS(.v13)], targets: [
    .target(name: "NovaAudioCore", path: "ios/nova_audio/Sources/nova_audio", exclude: ["NovaAudioPlugin.swift", "VoiceAudio.swift"], sources: ["AudioWire.swift", "PlaybackLedger.swift", "CaptureHandoff.swift"]),
    .testTarget(name: "NovaAudioCoreTests", dependencies: ["NovaAudioCore"], path: "Tests/NovaAudioCoreTests")
])
