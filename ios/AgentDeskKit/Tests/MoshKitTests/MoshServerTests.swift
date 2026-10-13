import CryptoKit
import Foundation
import SwiftTerm
import Testing
@testable import MoshKit

/// The real `mosh-server` 1.4.0, driven by this client and rendered with SwiftTerm as the app does.
private let moshServer = ["/opt/homebrew/bin/mosh-server", "/usr/local/bin/mosh-server", "/usr/bin/mosh-server"]
    .first { FileManager.default.isExecutableFile(atPath: $0) }

private struct LaunchedServer {
    let port: UInt16
    let key: MoshKey
    let pid: pid_t

    var running: Bool { kill(pid, 0) == 0 }

    init(_ command: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: moshServer!)
        process.arguments = ["new", "-i", "127.0.0.1", "-c", "256", "-l", "LANG=en_US.UTF-8", "--"] + command
        var environment = ProcessInfo.processInfo.environment
        environment["LANG"] = "en_US.UTF-8"
        environment["PS1"] = "$ "
        environment["MOSH_SERVER_NETWORK_TMOUT"] = "60"
        process.environment = environment
        let stdout = Pipe(), stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        let printed = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let detached = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let connect = try #require(printed.firstMatch(of: /MOSH CONNECT (\d+) (\S+)/))
        port = try #require(UInt16(connect.1))
        key = try MoshKey(String(connect.2))
        pid = try #require(detached.firstMatch(of: /pid = (\d+)/).flatMap { pid_t($0.1) })
    }
}

/// A terminal fed only by the server's screen updates.
private final class Screen: TerminalDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "Screen")
    private var terminal: Terminal!
    private var statuses: [MoshStatus] = []

    init(cols: Int, rows: Int) {
        terminal = Terminal(delegate: self, options: TerminalOptions(cols: cols, rows: rows, scrollback: 0))
    }

    func apply(_ events: [HostEvent]) {
        for event in events {
            switch event {
            case .output(let bytes):
                terminal.feed(byteArray: bytes)
            case .resize(let cols, let rows):
                if cols != terminal.cols || rows != terminal.rows { terminal.resize(cols: cols, rows: rows) }
            }
        }
    }

    func record(_ status: MoshStatus) { statuses.append(status) }

    var lines: [String] {
        queue.sync { (0..<terminal.rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" } }
    }

    var size: (cols: Int, rows: Int) { queue.sync { (terminal.cols, terminal.rows) } }
    var status: MoshStatus? { queue.sync { statuses.last } }

    // Mosh's server answers terminal queries itself; nothing the emulator says goes back.
    func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

private func client(for server: LaunchedServer, _ screen: Screen, cols: Int = 80, rows: Int = 24) -> MoshClient {
    MoshClient(host: "127.0.0.1", port: server.port, key: server.key, cols: cols, rows: rows, callbackQueue: screen.queue,
               onEvents: { [screen] in screen.apply($0) }, onStatus: { [screen] in screen.record($0) })
}

private func eventually(_ seconds: Double = 10, _ condition: () -> Bool) async -> Bool {
    let deadline = Date(timeIntervalSinceNow: seconds)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(50))
    }
    return condition()
}

private func type(_ client: MoshClient, _ text: String) { client.send(Array(text.utf8)) }

@Suite(.serialized, .enabled(if: moshServer != nil, "mosh-server is not installed"))
struct MoshServerTests {
    @Test func typingResizingLargeScreensAndPastesThenTheServerExits() async throws {
        let server = try LaunchedServer(["/bin/sh"])
        let screen = Screen(cols: 80, rows: 24)
        let mosh = client(for: server, screen)
        mosh.start()
        #expect(await eventually { screen.status == .connected })

        type(mosh, "echo mosh-$((6*7))\r")
        #expect(await eventually { screen.lines.contains("mosh-42") }, "\(screen.lines)")

        mosh.resize(cols: 100, rows: 30)
        type(mosh, "stty size\r")
        #expect(await eventually { screen.lines.contains("30 100") }, "\(screen.lines)")
        #expect(screen.size == (100, 30))

        // A screenful of incompressible text needs several fragments from the server.
        var generator = SystemRandomNumberGenerator()
        let content = (0..<28).map { _ in String((0..<99).map { _ in Character(UnicodeScalar(UInt8.random(in: 33...126, using: &generator))) }) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("mosh-screen-\(UUID().uuidString)")
        try (content.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: file) }
        type(mosh, "clear; cat \(file.path)\r")
        #expect(await eventually { Array(screen.lines[0..<28]) == content && screen.lines[28] == "$ " }, "\(screen.lines)")

        // A paste larger than one datagram reaches the program intact.
        let paste = (0..<4000).map { _ in UInt8.random(in: 97...122, using: &generator) }
        let digest = Insecure.MD5.hash(data: paste).map { String(format: "%02x", $0) }.joined()
        type(mosh, "clear; stty -icanon -echo; head -c 4000 | md5; stty icanon echo\r")
        try await Task.sleep(for: .milliseconds(500))
        mosh.send(paste)
        #expect(await eventually { screen.lines.contains(digest) }, "\(screen.lines)")

        type(mosh, "exit\r")
        #expect(await eventually { screen.status == .closed(.serverExited) }, "\(String(describing: screen.status))")
        #expect(await eventually { !server.running })
    }

    @Test func recoversFromHeavyPacketLossAndPortHopsThenClosesTheServer() async throws {
        let server = try LaunchedServer(["/bin/sh"])
        let screen = Screen(cols: 80, rows: 24)
        let mosh = client(for: server, screen)
        let counter = Counter()
        // Drop every third datagram in each direction.
        mosh.dropDatagram = { outgoing in counter.next(outgoing) % 3 == 2 }
        mosh.start()
        #expect(await eventually(20) { screen.status == .connected })

        for i in 1...5 {
            type(mosh, "echo loss-\(i * 11)\r")
            try await Task.sleep(for: .milliseconds(150))
        }
        #expect(await eventually(20) { (1...5).allSatisfy { i in screen.lines.contains("loss-\(i * 11)") } }, "\(screen.lines)")

        // A new UDP socket, as after switching from Wi-Fi to cellular: the server follows.
        mosh.networkChanged()
        type(mosh, "echo after-hop\r")
        #expect(await eventually(20) { screen.lines.contains("after-hop") }, "\(screen.lines)")

        mosh.close()
        #expect(await eventually { screen.status == .closed(.clientClosed) }, "\(String(describing: screen.status))")
        #expect(await eventually { !server.running })
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts = [false: 0, true: 0]

    func next(_ outgoing: Bool) -> Int {
        lock.withLock {
            counts[outgoing, default: 0] += 1
            return counts[outgoing]!
        }
    }
}
