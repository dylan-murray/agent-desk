import ActivityKit
import Foundation

/// The Live Activity for one desk host: how many sessions need you and are working, and the
/// question the longest-waiting session is asking.
struct DeskActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var needsYou: Int
        var working: Int
        var running: Int
        /// The session that needs you, if any: shown with its question.
        var waitingName: String?
        var waitingQuestion: String?
        var waitingID: String?
        var connected: Bool
        var updated: Date
    }

    var hostName: String
    var hostID: UUID
}

enum DeskLink {
    static let scheme = "agentdesk"

    /// agentdesk://session/<host id>/<terminal id>
    static func session(host: UUID, terminal: String) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "session"
        components.path = "/\(host.uuidString)/\(terminal)"
        return components.url!
    }

    static func host(_ host: UUID) -> URL {
        URL(string: "\(scheme)://host/\(host.uuidString)")!
    }
}
