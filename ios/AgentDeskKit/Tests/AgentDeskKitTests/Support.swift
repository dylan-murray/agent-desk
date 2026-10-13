import Crypto
import Foundation
import NIOSSH
import SwiftTerm
import Testing
@testable import AgentDeskKit
import MoshKit

/// A throwaway OpenSSH server on a loopback port, running as this user, that trusts one P-256
/// key generated for the test: the same kind of key the phone keeps in its Secure Enclave.
final class TestSSHServer: @unchecked Sendable {
    let directory: URL
    let port: Int
    let clientKey = P256.Signing.PrivateKey()
    let hostKey: HostKey
    private let process = Process()

    var username: String { NSUserName() }
    var key: NIOSSHPrivateKey { NIOSSHPrivateKey(p256Key: clientKey) }

    init() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("agent-desk-sshd-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.run("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", directory.appendingPathComponent("host").path)
        hostKey = HostKey(openSSH: try String(contentsOf: directory.appendingPathComponent("host.pub"), encoding: .utf8))
        let line = String(openSSHPublicKey: NIOSSHPrivateKey(p256Key: clientKey).publicKey)
        try (line + " agent-desk-test\n").write(to: directory.appendingPathComponent("authorized_keys"), atomically: true, encoding: .utf8)
        port = try Self.freePort()
        let config = """
            Port \(port)
            ListenAddress 127.0.0.1
            HostKey \(directory.path)/host
            AuthorizedKeysFile \(directory.path)/authorized_keys
            PidFile \(directory.path)/sshd.pid
            UsePAM no
            StrictModes no
            PasswordAuthentication no
            KbdInteractiveAuthentication no
            PubkeyAuthentication yes
            """
        try config.write(to: directory.appendingPathComponent("sshd_config"), atomically: true, encoding: .utf8)
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/sshd")
        process.arguments = ["-D", "-e", "-f", directory.appendingPathComponent("sshd_config").path]
        process.standardError = FileHandle(forWritingAtPath: "/dev/null")
        try process.run()
        let deadline = Date(timeIntervalSinceNow: 10)
        while !Self.accepts(port), Date() < deadline { usleep(50_000) }
    }

    deinit {
        process.terminate()
        process.waitUntilExit()
        try? FileManager.default.removeItem(at: directory)
    }

    /// The fingerprint OpenSSH itself reports for the host key.
    func opensshFingerprint() throws -> String {
        let output = try Self.run("/usr/bin/ssh-keygen", "-l", "-f", directory.appendingPathComponent("host.pub").path)
        return String(output.split(separator: " ")[1])
    }

    func connect(pinned: HostKey?, key: NIOSSHPrivateKey? = nil) async throws -> SSHConnection {
        try await SSHConnection.connect(host: "127.0.0.1", port: port, username: username, key: key ?? self.key, pinned: pinned)
    }

    @discardableResult
    static func run(_ executable: String, _ arguments: String...) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        process.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    private static func freePort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET),
                                  sin_port: 0, sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")), sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        try withUnsafeMutablePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                guard bind(fd, $0, length) == 0, getsockname(fd, $0, &length) == 0 else { throw DeskError("no free port") }
            }
        }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    private static func accepts(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET),
                                  sin_port: UInt16(port).bigEndian, sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")),
                                  sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }
}

/// A terminal fed only by a Mosh session's screen updates, as the app's terminal view is.
final class Screen: TerminalDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "Screen")
    private var terminal: Terminal!
    private var statuses: [MoshStatus] = []

    init(cols: Int, rows: Int) {
        terminal = Terminal(delegate: self, options: TerminalOptions(cols: cols, rows: rows, scrollback: 0))
    }

    func apply(_ events: [HostEvent]) {
        for event in events {
            switch event {
            case .output(let bytes): terminal.feed(byteArray: bytes)
            case .resize(let cols, let rows):
                if cols != terminal.cols || rows != terminal.rows { terminal.resize(cols: cols, rows: rows) }
            }
        }
    }

    func record(_ status: MoshStatus) { statuses.append(status) }

    var lines: [String] {
        queue.sync { (0..<terminal.rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" } }
    }

    var status: MoshStatus? { queue.sync { statuses.last } }

    func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

func eventually(_ seconds: Double = 10, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date(timeIntervalSinceNow: seconds)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(50))
    }
    return await condition()
}
