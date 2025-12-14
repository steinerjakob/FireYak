// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "CapApp-SPM-Builder",
    platforms: [
        .iOS("14.0"),
    ],
    dependencies: [
        .package(name: "RootPackage", path: "../.."),
    ],
    targets: [
        .executableTarget(
    name: "CapApp-SPM-App",
    dependencies: [
        .product(name: "CapApp-SPM", package: "RootPackage"),
    ],
    linkerSettings: [
    .unsafeFlags([
        "-Xlinker", "-rpath", "-Xlinker", "@executable_path/Frameworks",
    ]),
]
)
    ]
)
