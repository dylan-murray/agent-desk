import AgentDeskKit
import Foundation
import Observation

/// One host's desk: an SSH connection, what `agent-desk mobile` says about it, and a live
/// session list that reconnects on its own while the app is open.
@MainActor
@Observable
final class DeskConnection {
    enum State: Equatable {
        case idle
        case connecting
        case connected
        /// First visit: the person compares the fingerprint, then trusts it or not.
        case needsTrust(HostKey)
        case keyChanged(expected: HostKey, presented: HostKey)
        case failed(String)
    }

    var host: DeskHost
    private(set) var state = State.idle
    private(set) var info: DeskInfo?
    private(set) var snapshot: Snapshot?
    private(set) var client: DeskClient?
    /// Retrying after a failure, with this many seconds to go.
    private(set) var retryIn: Int?

    private unowned let app: AppModel
    private var watchTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var active = true
    private var failures = 0
    let activity: DeskActivityController

    init(host: DeskHost, app: AppModel) {
        self.host = host
        self.app = app
        activity = DeskActivityController(host: host)
    }

    var sessions: [Session] { snapshot?.sessions ?? [] }

    func session(_ id: String) -> Session? { sessions.first { $0.id == id } }

    /// Connects if not already connected or connecting.
    func connect() {
        guard connectTask == nil else { return }
        switch state {
        case .connected, .needsTrust, .keyChanged: return
        default: break
        }
        connectTask = Task { await run() }
    }

    func trust(_ key: HostKey) {
        host.hostKey = key
        app.save(host)
        state = .idle
        connect()
    }

    func retryNow() {
        guard case .failed = state else { return }
        state = .idle
        retryIn = nil
        connectTask?.cancel()
        connectTask = nil
        connect()
    }

    /// The app moved to the background: iOS will suspend it and its sockets soon. The Live
    /// Activity keeps its last reading, which the system marks stale after its stale date.
    func pause() {
        active = false
    }

    func resume() {
        active = true
        if client?.connection.isActive != true { reset(); connect() }
    }

    func disconnect() {
        reset()
        activity.end()
    }

    private func reset() {
        watchTask?.cancel()
        watchTask = nil
        connectTask?.cancel()
        connectTask = nil
        if let client { Task { await client.connection.close() } }
        client = nil
        if state == .connected || state == .connecting { state = .idle }
    }

    /// An open client, connecting first if needed. Terminals and launches use this.
    func ready() async throws -> DeskClient {
        if let client, client.connection.isActive { return client }
        connect()
        while true {
            if let client, client.connection.isActive, state == .connected { return client }
            switch state {
            case .failed(let message): throw DeskError(message)
            case .needsTrust, .keyChanged: throw DeskError("Confirm this server's key first.")
            default: try await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func run() async {
        defer { connectTask = nil }
        state = .connecting
        retryIn = nil
        do {
            let key = try PhoneKey.shared.key()
            let connection = try await SSHConnection.connect(host: host.hostname, port: host.sshPort, username: host.username,
                                                             key: key, pinned: host.hostKey)
            let client = DeskClient(host: host, connection: connection)
            info = try await client.info()
            self.client = client
            state = .connected
            failures = 0
            cleanUpAbandonedMoshServers(client)
            watch(client)
        } catch SSHError.unknownHostKey(let key) {
            state = .needsTrust(key)
        } catch SSHError.hostKeyChanged(let expected, let presented) {
            state = .keyChanged(expected: expected, presented: presented)
        } catch is CancellationError {
            state = .idle
        } catch {
            fail(error)
        }
    }

    private func watch(_ client: DeskClient) {
        watchTask?.cancel()
        watchTask = Task {
            do {
                for try await snapshot in client.watch() {
                    if snapshot != self.snapshot { self.snapshot = snapshot }
                    activity.update(snapshot)
                }
            } catch {
                guard !Task.isCancelled else { return }
                fail(error)
            }
        }
    }

    /// Shows the error and tries again, backing off, while the app is in the foreground.
    private func fail(_ error: Error) {
        state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        client = nil
        activity.markDisconnected()
        failures += 1
        let delay = min(30, 2 << min(failures, 4))
        Task {
            for remaining in stride(from: delay, to: 0, by: -1) {
                guard case .failed = state, active else { retryIn = nil; return }
                retryIn = remaining
                try? await Task.sleep(for: .seconds(1))
            }
            retryIn = nil
            if case .failed = state, active { state = .idle; connect() }
        }
    }

    // MARK: - Mosh servers this phone started

    private var moshPIDsKey: String { "mosh-pids-\(host.id.uuidString)" }

    func rememberMoshServer(_ pid: Int32) {
        var pids = UserDefaults.standard.array(forKey: moshPIDsKey) as? [Int32] ?? []
        pids.append(pid)
        UserDefaults.standard.set(pids, forKey: moshPIDsKey)
    }

    func forgetMoshServer(_ pid: Int32) {
        let pids = (UserDefaults.standard.array(forKey: moshPIDsKey) as? [Int32] ?? []).filter { $0 != pid }
        UserDefaults.standard.set(pids, forKey: moshPIDsKey)
    }

    /// Terminals left open when the app was last closed leave their mosh-server waiting for a
    /// phone that will never return to it. Stop those, but not ones open right now.
    private func cleanUpAbandonedMoshServers(_ client: DeskClient) {
        let open = TerminalController.openServers
        let abandoned = (UserDefaults.standard.array(forKey: moshPIDsKey) as? [Int32] ?? []).filter { !open.contains($0) }
        guard !abandoned.isEmpty else { return }
        Task {
            for pid in abandoned {
                await client.stopMoshServer(pid: pid)
                forgetMoshServer(pid)
            }
        }
    }
}
