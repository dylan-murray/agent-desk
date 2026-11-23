import ActivityKit
import AgentDeskKit
import Foundation

/// Keeps one desk's Live Activity current while the app is connected to it. Without push
/// notifications nothing updates it once iOS suspends the app, so each update says how long
/// it stays fresh and the system dims it after that.
@MainActor
final class DeskActivityController {
    /// How long a reading stays current once the app stops updating it.
    static let freshFor: TimeInterval = 5 * 60

    private let host: DeskHost
    private var activity: Activity<DeskActivityAttributes>?
    private var last: DeskActivityAttributes.ContentState?

    init(host: DeskHost) {
        self.host = host
        activity = Activity<DeskActivityAttributes>.activities.first { $0.attributes.hostID == host.id }
    }

    func update(_ snapshot: Snapshot) {
        let running = snapshot.sessions.filter(\.isRunning)
        let waiting = running.filter(\.needsInput).min { ($0.lastOutput ?? 0) < ($1.lastOutput ?? 0) }
        var state = DeskActivityAttributes.ContentState(
            needsYou: running.filter(\.needsInput).count, working: running.filter(\.isWorking).count, running: running.count,
            waitingName: waiting?.name, waitingQuestion: waiting?.question, waitingID: waiting?.id, connected: true,
            updated: last?.updated ?? .now)
        // Only the counts and the question matter; a new timestamp alone is not worth an update.
        guard state != last else { return }
        state.updated = .now
        last = state
        publish(state)
    }

    func markDisconnected() {
        guard var state = last, state.connected else { return }
        state.connected = false
        state.updated = .now
        last = state
        publish(state)
    }

    func end() {
        guard let id = activity?.id else { return }
        activity = nil
        last = nil
        Task.detached { await Self.find(id)?.end(nil, dismissalPolicy: .immediate) }
    }

    /// Activity is not Sendable, so work off the main actor looks it up again by ID.
    private nonisolated static func find(_ id: String) -> Activity<DeskActivityAttributes>? {
        Activity<DeskActivityAttributes>.activities.first { $0.id == id }
    }

    private func publish(_ state: DeskActivityAttributes.ContentState) {
        let content = ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: Self.freshFor),
                                      relevanceScore: state.needsYou > 0 ? 100 : 10)
        if let activity, activity.activityState == .active {
            let id = activity.id
            Task.detached { await Self.find(id)?.update(content) }
            return
        }
        // A Live Activity can only start while the app is on screen, and only for a desk with work.
        guard state.running > 0, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        activity = try? Activity.request(attributes: DeskActivityAttributes(hostName: host.name, hostID: host.id),
                                         content: content, pushType: nil)
    }
}
