import AgentDeskKit
import Foundation
import MoshKit
import Network
import Observation
import SwiftTerm

/// One terminal on screen: a Mosh session to `agent-desk attach`, drawn by SwiftTerm.
@MainActor
@Observable
final class TerminalController {
    enum Phase: Equatable {
        case starting
        case live(MoshStatus)
        case failed(String)
    }

    /// mosh-server PIDs of terminals open in this process, which must not be cleaned up.
    static var openServers: Set<Int32> = []

    let sessionID: String
    private(set) var phase = Phase.starting
    /// The approval menu on screen right now, if any, with the keys that answer it.
    private(set) var approval: ApprovalMenu?

    private let connection: DeskConnection
    private var mosh: MoshClient?
    private var pid: Int32?
    private var pathMonitor: NWPathMonitor?
    private var size = (cols: 80, rows: 24)
    private var pending: [[UInt8]] = []
    private var menuCheck: Task<Void, Never>?
    private var sawFirstPath = false
    weak var view: TerminalView? {
        didSet { flush() }
    }

    init(sessionID: String, connection: DeskConnection) {
        self.sessionID = sessionID
        self.connection = connection
    }

    func start() async {
        guard mosh == nil else { return }
        phase = .starting
        do {
            let client = try await connection.ready()
            let ticket = try await client.startMosh(terminal: sessionID)
            if let pid = ticket.pid {
                self.pid = pid
                Self.openServers.insert(pid)
                connection.rememberMoshServer(pid)
            }
            let mosh = MoshClient(host: client.connection.remoteAddress ?? connection.host.hostname, port: ticket.port,
                                  key: ticket.key, cols: size.cols, rows: size.rows,
                                  onEvents: { [weak self] events in MainActor.assumeIsolated { self?.receive(events) } },
                                  onStatus: { [weak self] status in MainActor.assumeIsolated { self?.statusChanged(status) } })
            self.mosh = mosh
            phase = .live(.connecting)
            mosh.start()
            watchNetwork()
        } catch {
            phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    /// Leaving the terminal: Mosh tells its server to stop, and the pane keeps running.
    func stop() {
        mosh?.close()
        pathMonitor?.cancel()
        pathMonitor = nil
        menuCheck?.cancel()
    }

    /// Back from the background, or onto a new network: Mosh picks up where it left off.
    func resume() {
        mosh?.networkChanged()
    }

    func retry() {
        mosh = nil
        Task { await start() }
    }

    func send(_ bytes: [UInt8]) {
        mosh?.send(bytes)
    }

    func send(_ text: String) {
        send(Array(text.utf8))
    }

    func resized(cols: Int, rows: Int) {
        guard cols > 0, rows > 0, (cols, rows) != size else { return }
        size = (cols, rows)
        mosh?.resize(cols: cols, rows: rows)
    }

    private func statusChanged(_ status: MoshStatus) {
        phase = .live(status)
        if case .closed = status, let pid {
            Self.openServers.remove(pid)
            connection.forgetMoshServer(pid)
            self.pid = nil
            pathMonitor?.cancel()
        }
    }

    private func receive(_ events: [HostEvent]) {
        for event in events {
            switch event {
            case .output(let bytes):
                pending.append(bytes)
            case .resize(let cols, let rows):
                flush()
                // The updates that follow were drawn for the server's screen size; match it until
                // the size this view asked for arrives.
                if let terminal = view?.getTerminal(), terminal.cols != cols || terminal.rows != rows {
                    terminal.resize(cols: cols, rows: rows)
                }
            }
        }
        flush()
    }

    private func flush() {
        guard let view, !pending.isEmpty else { return }
        for bytes in pending { view.feed(byteArray: bytes[...]) }
        pending.removeAll()
        scheduleMenuCheck()
    }

    private func scheduleMenuCheck() {
        menuCheck?.cancel()
        menuCheck = Task {
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let terminal = view?.getTerminal() else { return }
            let lines = (0..<terminal.rows).map { terminal.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
            let menu = ApprovalMenu(screen: lines)
            if menu != approval { approval = menu }
        }
    }

    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            MainActor.assumeIsolated { self?.pathChanged() }
        }
        monitor.start(queue: .main)
        pathMonitor = monitor
    }

    private func pathChanged() {
        // The first report describes the path Mosh started on.
        guard sawFirstPath else { sawFirstPath = true; return }
        resume()
    }
}

/// A numbered Yes/No menu or a y/n prompt on screen, read the way the desk reads it, so the
/// phone can answer with one tap.
struct ApprovalMenu: Equatable {
    var yes: String
    var no: String
    var yesLabel: String
    var noLabel: String

    init?(screen lines: [String]) {
        // Only the bottom of the screen: an old prompt higher up is not the current question.
        let recent = lines.reversed().drop { $0.trimmingCharacters(in: .whitespaces).isEmpty }.prefix(12).reversed()
        let text = recent.joined(separator: "\n")
        var yes: (String, String)?, no: (String, String)?
        for line in recent {
            if let match = line.firstMatch(of: /([1-9])[.)]\s*(Yes\b[^\n]{0,40})/.ignoresCase()), yes == nil {
                yes = (String(match.1), String(match.2))
            }
            if let match = line.firstMatch(of: /([1-9])[.)]\s*(No\b[^\n]{0,40})/.ignoresCase()), no == nil {
                no = (String(match.1), String(match.2))
            }
        }
        if let yes, let no {
            self.yes = yes.0
            self.no = no.0
            yesLabel = Self.short(yes.1)
            noLabel = Self.short(no.1)
        } else if text.contains(/\[[yY]\/[nN]\]|\([yY]\/[nN]\)/) {
            self.yes = "y"
            self.no = "n"
            yesLabel = "Yes"
            noLabel = "No"
        } else {
            return nil
        }
    }

    /// "Yes, and don't ask again" reads as "Yes" on a button; the digit picks the exact option.
    private static func short(_ label: String) -> String {
        String(label.prefix { $0.isLetter }).capitalized
    }
}
