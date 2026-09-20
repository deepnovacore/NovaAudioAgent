// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription
import Foundation
// The vendor framework contains device code only; SwiftPM cannot filter a binary target by simulator.
let hasAOQ = ProcessInfo.processInfo.environment["NOVA_AOQ_SIMULATOR"] != "1" && FileManager.default.fileExists(atPath: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vendor/AoqClientSdk.xcframework").path)

let package = Package(
    name: "nova_audio",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .library(name: "nova-audio", targets: ["nova_audio"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework")
    ],
    targets: [
        .target(
            name: "nova_audio",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework")
            ] + (hasAOQ ? [.target(name: "AoqClientSdk")] : []),
            resources: [
                // If your plugin requires a privacy manifest, for example if it uses any required
                // reason APIs, update the PrivacyInfo.xcprivacy file to describe your plugin's
                // privacy impact, and then uncomment these lines. For more information, see
                // https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
                // .process("PrivacyInfo.xcprivacy"),

                // If you have other resources that need to be bundled with your plugin, refer to
                // the following instructions to add them:
                // https://developer.apple.com/documentation/xcode/bundling-resources-with-a-swift-package
            ]
        )
    ] + (hasAOQ ? [.binaryTarget(name: "AoqClientSdk", path: "Vendor/AoqClientSdk.xcframework")] : [])
)
