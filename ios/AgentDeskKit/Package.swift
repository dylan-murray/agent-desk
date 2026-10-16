// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentDeskKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "MoshKit", targets: ["MoshKit"]),
        .library(name: "AgentDeskKit", targets: ["AgentDeskKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.86.0"),
        .package(url: "https://github.com/apple/swift-nio-ssh.git", .upToNextMinor(from: "0.15.0")),
        .package(url: "https://github.com/apple/swift-crypto.git", "3.12.0"..<"5.0.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", .upToNextMinor(from: "1.20.0")),
    ],
    targets: [
        .target(name: "MoshKit"),
        .target(name: "AgentDeskKit", dependencies: [
            "MoshKit",
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOPosix", package: "swift-nio"),
            .product(name: "NIOSSH", package: "swift-nio-ssh"),
            .product(name: "Crypto", package: "swift-crypto"),
        ]),
        .testTarget(name: "MoshKitTests", dependencies: ["MoshKit", .product(name: "SwiftTerm", package: "SwiftTerm")]),
        .testTarget(name: "AgentDeskKitTests", dependencies: ["AgentDeskKit", .product(name: "SwiftTerm", package: "SwiftTerm")]),
    ]
)
