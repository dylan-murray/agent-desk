import Foundation
import MoshKit
import Testing
@testable import AgentDeskKit

/// The whole path the app takes, against a running desk: SSH to this Mac, `agent-desk mobile`
/// for the session list and launches, and `mosh-server` running `agent-desk attach` for the
/// terminal. Set AGENT_DESK_E2E_PORT to a test desk's port (never the live one) and
/// AGENT_DESK_E2E_COMMAND to the agent-desk command that reaches it.
private let deskPort = ProcessInfo.processInfo.environment["AGENT_DESK_E2E_PORT"].flatMap(Int.init)
private let deskCommand = ProcessInfo.processInfo.environment["AGENT_DESK_E2E_COMMAND"] ?? "agent-desk"

@Suite(.serialized, .enabled(if: deskPort != nil, "Set AGENT_DESK_E2E_PORT to run against a test desk"))
struct DeskEndToEndTests {
    @Test func phoneLaunchesAPaneWatchesItTypesOverMoshAndDetachesWithoutStoppingIt() async throws {
        let server = try TestSSHServer()
        var host = DeskHost(name: "This Mac", hostname: "127.0.0.1", username: server.username)
        host.sshPort = server.port
        host.deskPort = try #require(deskPort)
        host.agentDeskCommand = deskCommand
        host.hostKey = server.hostKey
        let ssh = try await server.connect(pinned: server.hostKey)
        let desk = DeskClient(host: host, connection: ssh)

        let info = try await desk.info()
        #expect(info.port == host.deskPort)
        #expect(info.desks.contains { $0.id == "main" })
        #expect(info.launchChoices.contains { $0.key == "shell" })

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("phone-pane-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let id = try await desk.launch(LaunchRequest(choice: "shell", cwd: folder.path, desk: "main", prompt: nil))
        let launched = try await firstSnapshot(desk) { $0.sessions.contains { $0.id == id } }
        #expect(launched.sessions.first { $0.id == id }?.cwd == folder.path)

        // Attach over Mosh and type, the way the terminal screen does.
        var ticket = try await desk.startMosh(terminal: id)
        var screen = Screen(cols: 80, rows: 24)
        var mosh = attach(ticket, ssh, screen)
        #expect(await eventually { screen.status == .connected })
        // Type once the shell's prompt, which names the folder, is up: zsh drops earlier typeahead.
        #expect(await eventually(20) { screen.lines.contains { $0.contains(folder.lastPathComponent) } }, "\(screen.lines)")
        mosh.send(Array("echo phone-$((6*7))\r".utf8))
        #expect(await eventually { screen.lines.contains("phone-42") }, "\(screen.lines)")

        // An approval menu on screen is reported to the session list.
        mosh.send(Array(#"clear; printf '\104o you want to proceed?\n\342\235\257 1. Yes\n  2. No\n'"#.utf8) + [0x0d])
        let asking = try await firstSnapshot(desk, seconds: 20) { $0.sessions.first { $0.id == id }?.needsInput == true }
        #expect(asking.sessions.first { $0.id == id }?.question == "Do you want to proceed?")

        // Leaving the terminal ends Mosh and its server, and the pane keeps running.
        mosh.close()
        #expect(await eventually { screen.status == .closed(.clientClosed) })
        let pid = try #require(ticket.pid)
        #expect(await eventually { kill(pid, 0) != 0 })
        let after = try await firstSnapshot(desk) { $0.sessions.contains { $0.id == id } }
        #expect(after.sessions.first { $0.id == id }?.isRunning == true)

        // Coming back replays the pane, then exiting the shell ends the session.
        ticket = try await desk.startMosh(terminal: id)
        screen = Screen(cols: 80, rows: 24)
        mosh = attach(ticket, ssh, screen)
        #expect(await eventually { screen.lines.contains { $0.contains("2. No") } }, "\(screen.lines)")
        mosh.send(Array("exit 4\r".utf8))
        #expect(await eventually { screen.status == .closed(.serverExited) }, "\(String(describing: screen.status))")
        let exited = try await firstSnapshot(desk) { $0.sessions.first { $0.id == id }?.exitCode == 4 }
        #expect(exited.sessions.first { $0.id == id }?.isRunning == false)
        await ssh.close()
    }

    private func attach(_ ticket: MoshTicket, _ ssh: SSHConnection, _ screen: Screen) -> MoshClient {
        let mosh = MoshClient(host: ssh.remoteAddress ?? "127.0.0.1", port: ticket.port, key: ticket.key, cols: 80, rows: 24,
                              callbackQueue: screen.queue, onEvents: { [screen] in screen.apply($0) },
                              onStatus: { [screen] in screen.record($0) })
        mosh.start()
        return mosh
    }

    private func firstSnapshot(_ desk: DeskClient, seconds: Double = 15,
                               where condition: @escaping @Sendable (Snapshot) -> Bool) async throws -> Snapshot {
        try await withThrowingTaskGroup(of: Snapshot.self) { group in
            group.addTask {
                for try await snapshot in desk.watch() where condition(snapshot) { return snapshot }
                throw DeskError("watch ended")
            }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw DeskError("no matching snapshot within \(seconds)s")
            }
            let snapshot = try await group.next()!
            group.cancelAll()
            return snapshot
        }
    }
}
