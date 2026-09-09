// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "NovaCore", platforms: [.macOS(.v13)], products: [], targets: [
    .target(name: "NovaCore", path: "Nova/Protocol"),
    .testTarget(name: "NovaCoreTests", dependencies: ["NovaCore"], path: "NovaTests")
])
