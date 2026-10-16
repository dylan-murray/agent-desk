import AgentDeskKit
import Foundation
import Observation

/// The hosts this phone knows, and a connection to each one that is open.
@MainActor
@Observable
final class AppModel {
    private static let hostsKey = "hosts"
    private let defaults: UserDefaults

    private(set) var hosts: [DeskHost] = []
    private var connections: [UUID: DeskConnection] = [:]
    var path: [Route] = []

    enum Route: Hashable {
        case host(UUID)
        case terminal(host: UUID, session: String)
        case phoneKey
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.hostsKey), let saved = try? JSONDecoder().decode([DeskHost].self, from: data) {
            hosts = saved
        }
    }

    func host(_ id: UUID) -> DeskHost? { hosts.first { $0.id == id } }

    func save(_ host: DeskHost) {
        if let index = hosts.firstIndex(where: { $0.id == host.id }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
        connections[host.id]?.host = host
        persist()
    }

    func delete(_ id: UUID) {
        connections.removeValue(forKey: id)?.disconnect()
        hosts.removeAll { $0.id == id }
        path.removeAll {
            switch $0 {
            case .host(id), .terminal(id, _): true
            default: false
            }
        }
        persist()
    }

    func connection(_ id: UUID) -> DeskConnection? {
        if let open = connections[id] { return open }
        guard let host = host(id) else { return nil }
        let connection = DeskConnection(host: host, app: self)
        connections[id] = connection
        return connection
    }

    /// Opening the app again: reconnect what was open, and let Mosh sessions find their servers.
    func becameActive() {
        for connection in connections.values { connection.resume() }
    }

    func movedToBackground() {
        PhoneKey.shared.lock()
        for connection in connections.values { connection.pause() }
    }

    /// Follows agentdesk:// links from the Live Activity.
    func open(_ url: URL) {
        guard url.scheme == DeskLink.scheme else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard let id = parts.first.flatMap(UUID.init(uuidString:)), host(id) != nil else { return }
        if url.host == "session", parts.count >= 2 {
            path = [.host(id), .terminal(host: id, session: parts[1])]
        } else {
            path = [.host(id)]
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(hosts) { defaults.set(data, forKey: Self.hostsKey) }
    }
}
