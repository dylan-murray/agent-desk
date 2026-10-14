import Foundation
import MoshKit

/// A machine running Agent Desk, reached over SSH. Nothing here is secret: the phone's key
/// lives in the Keychain, and the host key is public.
public struct DeskHost: Codable, Hashable, Identifiable, Sendable {
    public var id = UUID()
    public var name: String
    public var hostname: String
    public var sshPort = 22
    public var username: String
    /// The port Agent Desk serves on, on that machine's loopback.
    public var deskPort = 4310
    /// How to run Agent Desk there, through a login shell, such as `agent-desk` or `python3 -m agent_desk`.
    public var agentDeskCommand = "agent-desk"
    public var moshServerCommand = "mosh-server"
    /// Pinned on first connection, once the person has compared its fingerprint.
    public var hostKey: HostKey?

    public init(name: String, hostname: String, username: String) {
        self.name = name
        self.hostname = hostname
        self.username = username
    }
}

// MARK: - What `agent-desk mobile` answers

public struct DeskRef: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
}

public struct LaunchChoice: Codable, Hashable, Identifiable, Sendable {
    public var key: String
    public var label: String
    public var harness: String
    public var id: String { key }
}

public struct Project: Codable, Hashable, Identifiable, Sendable {
    public var name: String
    public var path: String
    public var id: String { path }
}

public struct DeskInfo: Decodable, Sendable {
    public var `protocol`: Int
    public var port: Int
    public var desks: [DeskRef]
    public var launchChoices: [LaunchChoice]
    public var projects: [Project]
}

public struct Session: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var desk: String?
    public var harness: String?
    public var launchProfile: String?
    public var cwd: String?
    public var project: String?
    /// needs_input, output or quiet while it runs; the desk's own status once it has exited.
    public var status: String
    public var question: String?
    public var exitCode: Int?
    public var lastOutput: Double?
    public var activeSince: Double?
    public var parentId: String?
    public var remote: Bool
    public var controller: Bool
    /// Protected at the desk: only the desk itself can read or type into it.
    public var protected: Bool?

    public var isRunning: Bool { exitCode == nil }
    public var needsInput: Bool { isRunning && status == "needs_input" }
    public var isWorking: Bool { isRunning && status == "output" }
    public var isProtected: Bool { protected == true }
}

public struct Snapshot: Decodable, Sendable, Equatable {
    public var desks: [DeskRef]
    public var sessions: [Session]
    /// False until every running terminal's screen has been read for approval prompts.
    public var ready: Bool
}

public struct LaunchRequest: Encodable, Sendable {
    public var choice: String
    public var cwd: String
    public var desk: String?
    public var prompt: String?

    public init(choice: String, cwd: String, desk: String?, prompt: String?) {
        self.choice = choice
        self.cwd = cwd
        self.desk = desk
        self.prompt = prompt
    }
}

public struct DeskError: Error, LocalizedError, Equatable {
    public var message: String
    public var errorDescription: String? { message }
    public init(_ message: String) { self.message = message }
}

/// Where a new `mosh-server` is listening, and the key it expects.
public struct MoshTicket: Sendable, Equatable {
    public var port: UInt16
    public var key: MoshKey
    public var pid: Int32?
}

// MARK: - Commands

enum Remote {
    static let supportedProtocol = 1
    /// How long `mosh-server` keeps a session for a phone that has gone silent: long enough to
    /// survive a night in a pocket, short enough that abandoned servers clean themselves up.
    static let moshIdleSeconds = 6 * 60 * 60

    static func quote(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Runs through the person's login shell, which is what puts Homebrew and pipx on PATH.
    static func loginShell(_ command: String) -> String {
        "exec \"$SHELL\" -lc " + quote(command)
    }

    static func mobile(_ host: DeskHost, _ arguments: String) -> String {
        loginShell("\(host.agentDeskCommand) mobile --port \(host.deskPort) \(arguments)")
    }

    static func attach(_ host: DeskHost, terminal: String) -> String {
        loginShell("LANG=en_US.UTF-8 MOSH_SERVER_NETWORK_TMOUT=\(moshIdleSeconds) \(host.moshServerCommand) new -s -c 256 "
            + "-l LANG=en_US.UTF-8 -- \(host.agentDeskCommand) attach --port \(host.deskPort) \(quote(terminal))")
    }

    static func stopMoshServer(pid: Int32) -> String {
        // Only ever a mosh-server this phone started: the PID may have been reused since.
        "ps -p \(pid) -o comm= | grep -q mosh-server && kill \(pid); true"
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private struct Envelope: Decodable {
        var type: String
        var `protocol`: Int?
        var message: String?
    }

    /// Login shells can print banners before the answer, so this reads the JSON line, not stdout.
    static func decodeLine<T: Decodable>(_ line: Substring, as type: T.Type, expecting kind: String) throws -> T? {
        let text = line.trimmingCharacters(in: .whitespaces)
        guard text.hasPrefix("{"), let data = text.data(using: .utf8),
              let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        if envelope.type == "error" { throw DeskError(envelope.message ?? "Agent Desk reported an error.") }
        if let version = envelope.protocol, version != supportedProtocol {
            throw DeskError(version > supportedProtocol
                ? "The server runs a newer Agent Desk than this app understands. Update the app."
                : "The server runs an older Agent Desk. Update it there to use this app.")
        }
        guard envelope.type == kind else { return nil }
        return try decoder.decode(T.self, from: data)
    }

    static func decodeAnswer<T: Decodable>(_ result: CommandResult, as type: T.Type, expecting kind: String) throws -> T {
        let text = String(decoding: result.stdout, as: UTF8.self)
        for line in text.split(separator: "\n").reversed() {
            if let value = try decodeLine(line, as: type, expecting: kind) { return value }
        }
        throw commandError(result)
    }

    static func commandError(_ result: CommandResult) -> DeskError {
        let stderr = String(decoding: result.stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if result.status == 127 || stderr.contains("command not found") || stderr.contains("No module named agent_desk") {
            return DeskError("Agent Desk was not found by the login shell on the server. Install it there, or set the "
                + "command to run it in this host's settings. (\(stderr.split(separator: "\n").last ?? ""))")
        }
        if stderr.contains("invalid choice: 'mobile'") || stderr.contains("unrecognized arguments") {
            return DeskError("The server's Agent Desk is too old for this app. Update it there.")
        }
        return DeskError(stderr.isEmpty ? "Agent Desk exited with status \(result.status)." : String(stderr.suffix(400)))
    }

    static func parseMoshConnect(_ result: CommandResult) throws -> MoshTicket {
        let stdout = String(decoding: result.stdout, as: UTF8.self)
        let stderr = String(decoding: result.stderr, as: UTF8.self)
        guard let match = stdout.firstMatch(of: /MOSH CONNECT (\d+) ([A-Za-z0-9\/+]{22})/), let port = UInt16(match.1) else {
            if result.status == 127 || stderr.contains("command not found") {
                throw DeskError("mosh-server was not found by the login shell on the server. Install Mosh there "
                    + "(brew install mosh, or apt install mosh), or set its full path in this host's settings.")
            }
            let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw DeskError(detail.isEmpty ? "mosh-server did not start." : "mosh-server did not start: \(detail.suffix(300))")
        }
        let pid = stderr.firstMatch(of: /pid = (\d+)/).flatMap { Int32($0.1) }
        return MoshTicket(port: port, key: try MoshKey(String(match.2)), pid: pid)
    }
}

/// Agent Desk on one host, over an authenticated SSH connection.
public final class DeskClient: Sendable {
    public let host: DeskHost
    public let connection: SSHConnection

    public init(host: DeskHost, connection: SSHConnection) {
        self.host = host
        self.connection = connection
    }

    public func info() async throws -> DeskInfo {
        try Remote.decodeAnswer(try await connection.run(Remote.mobile(host, "info")), as: DeskInfo.self, expecting: "info")
    }

    /// A snapshot of every session now, and another whenever one changes.
    public func watch() -> AsyncThrowingStream<Snapshot, Error> {
        let events = connection.exec(Remote.mobile(host, "watch"))
        return AsyncThrowingStream { continuation in
            let task = Task {
                var pending = Data(), stderr = Data()
                var status = 0
                do {
                    for try await event in events {
                        switch event {
                        case .stdout(let data):
                            pending += data
                            while let newline = pending.firstIndex(of: 0x0a) {
                                let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
                                pending = Data(pending[(newline + 1)...])
                                if let snapshot = try Remote.decodeLine(line[...], as: Snapshot.self, expecting: "snapshot") {
                                    continuation.yield(snapshot)
                                }
                            }
                        case .stderr(let data): stderr += data
                        case .exit(let code): status = code
                        }
                    }
                    if Task.isCancelled {
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: status == 0 ? SSHError.disconnected
                            : Remote.commandError(CommandResult(stdout: pending, stderr: stderr, status: status)))
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Starts an agent the way the desk's own launch dialog does, and returns its terminal ID.
    public func launch(_ request: LaunchRequest) async throws -> String {
        struct Launched: Decodable { struct Terminal: Decodable { var id: String }; var session: Terminal }
        let input = try JSONEncoder().encode(request)
        let result = try await connection.run(Remote.mobile(host, "launch"), input: input)
        return try Remote.decodeAnswer(result, as: Launched.self, expecting: "launched").session.id
    }

    /// Starts `mosh-server` running `agent-desk attach` for one terminal.
    public func startMosh(terminal: String) async throws -> MoshTicket {
        try Remote.parseMoshConnect(try await connection.run(Remote.attach(host, terminal: terminal)))
    }

    /// Stops a `mosh-server` this phone started and can no longer reach, such as after the app was closed.
    public func stopMoshServer(pid: Int32) async {
        _ = try? await connection.run(Remote.stopMoshServer(pid: pid))
    }
}
