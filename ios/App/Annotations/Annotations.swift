import AgentDeskKit
import CryptoKit
import Foundation
import Observation
import UIKit

/// Developer annotations on this app's own screens: pins with notes and screenshots, kept on
/// the phone until they are sent to a coding agent on a desk.
@MainActor
@Observable
final class Annotations {
    static let shared = Annotations()

    enum Mode: Equatable {
        case idle
        /// Waiting for a tap on whatever should change.
        case pinning
        case composing(Draft)
        case reviewing
    }

    /// A pin being written.
    struct Draft: Equatable {
        var id = UUID().uuidString
        var point: CGPoint
        var target: AnnotationTargets.Target?
        var screen: String
        var screenshot: Data
        var text = ""
    }

    struct Saved: Codable, Identifiable, Equatable {
        var note: AnnotationNote
        var screenshot: String
        var id: String { note.id }
    }

    var mode = Mode.idle
    private(set) var notes: [Saved] = []
    private(set) var sending = false
    /// What happened to the last submission, for the person to read.
    private(set) var outcome: String?
    /// The session the next submission goes to, as host ID and terminal ID.
    var destination: Destination?
    /// Describes the screen on show, such as "Terminal · Fix coupon total". Set by the app.
    var describeScreen: () -> String = { "Agent Desk" }

    struct Destination: Hashable, Codable {
        var host: UUID
        var session: String
    }

    private let folder: URL

    init(folder: URL = URL.applicationSupportDirectory.appending(path: "annotations")) {
        self.folder = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: folder.appending(path: "notes.json")),
           let saved = try? JSONDecoder().decode([Saved].self, from: data) {
            notes = saved
        }
        if let data = UserDefaults.standard.data(forKey: "annotationDestination") {
            destination = try? JSONDecoder().decode(Destination.self, from: data)
        }
    }

    func number(of id: String) -> Int {
        (notes.firstIndex { $0.id == id } ?? notes.count) + 1
    }

    // MARK: - Pinning

    /// The person tapped `point` while pinning: picture the screen as it is, then ask what to change.
    func pin(at point: CGPoint) {
        let targets = AnnotationTargets.shared
        let target = targets.target(at: point)
        guard let window = targets.appWindow,
              let screenshot = Self.screenshot(of: window, pin: point, number: notes.count + 1, outline: target?.frame) else { return }
        let sheet = targets.presentation.depth > 0 ? " (sheet open)" : ""
        mode = .composing(Draft(point: point, target: target, screen: describeScreen() + sheet, screenshot: screenshot))
    }

    func save(_ draft: Draft) {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { mode = .pinning; return }
        let file = "\(draft.id).jpg"
        try? draft.screenshot.write(to: folder.appending(path: file), options: .completeFileProtection)
        let window = AnnotationTargets.shared.appWindow
        let bounds = window?.bounds ?? .zero
        let scale = window?.screen.scale ?? 1
        let traits = window?.traitCollection ?? UITraitCollection.current
        let note = AnnotationNote(
            id: draft.id, note: text, createdAt: .now, app: Self.appDescription, screen: draft.screen,
            element: draft.target.map { .init(id: $0.id, detail: $0.detail, source: $0.source, frame: $0.frame) },
            point: draft.point,
            display: .init(width: bounds.width, height: bounds.height, scale: scale,
                           appearance: traits.userInterfaceStyle == .dark ? "dark" : "light",
                           textSize: traits.preferredContentSizeCategory.rawValue),
            device: UIDevice.current.model + (Self.isSimulator ? " Simulator" : ""),
            system: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)")
        notes.append(Saved(note: note, screenshot: file))
        persist()
        mode = .pinning
    }

    func delete(_ id: String) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        try? FileManager.default.removeItem(at: folder.appending(path: notes[index].screenshot))
        notes.remove(at: index)
        persist()
    }

    func screenshot(for saved: Saved) -> UIImage? {
        UIImage(contentsOfFile: folder.appending(path: saved.screenshot).path)
    }

    func dismissOutcome() {
        outcome = nil
    }

    // MARK: - Sending

    /// Sends every saved note for the chosen session, through that session's desk. A worker's
    /// notes go to its coordinator.
    func send(through connection: DeskConnection, to session: Session) async {
        guard !notes.isEmpty, !sending, let target = session.feedbackTarget else { return }
        let recipient = session.feedbackTargetName ?? session.name
        sending = true
        outcome = nil
        defer { sending = false }
        let batch = notes
        do {
            let client = try await connection.ready()
            var screenshots: [String: Data] = [:]
            for saved in batch {
                screenshots[saved.id] = try? Data(contentsOf: folder.appending(path: saved.screenshot))
            }
            let result = try await client.sendFeedback(requestID: Self.requestID(batch.map(\.note), target), target: target,
                                                       notes: batch.map(\.note), screenshots: screenshots)
            for saved in batch { delete(saved.id) }
            let count = batch.count == 1 ? "1 note" : "\(batch.count) notes"
            outcome = result.queued
                ? "\(count) queued for \(recipient). The desk types them in once it is at an empty prompt."
                : "\(count) sent to \(recipient)."
            if notes.isEmpty { mode = .idle }
        } catch {
            outcome = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// The same notes to the same session always make the same ID, so sending again after a lost
    /// reply is recognised by the desk instead of delivered twice.
    static func requestID(_ notes: [AnnotationNote], _ target: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let notes = (try? encoder.encode(notes)) ?? Data()
        let digest = SHA256.hash(data: notes + Data(target.utf8))
        return "ios-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(notes) {
            try? data.write(to: folder.appending(path: "notes.json"), options: [.atomic, .completeFileProtection])
        }
        if let destination, let data = try? JSONEncoder().encode(destination) {
            UserDefaults.standard.set(data, forKey: "annotationDestination")
        }
    }

    func choose(_ destination: Destination) {
        self.destination = destination
        persist()
    }

    // MARK: - Context

    static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    static var appDescription: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "Agent Desk iOS \(version) (\(build)), the ios/ app in the agent-desk repository"
    }

    /// The app window as drawn now, with the pin and the outline of the view it landed on.
    static func screenshot(of window: UIWindow, pin: CGPoint, number: Int, outline: CGRect?) -> Data? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            let amber = UIColor(red: 0xe7 / 255, green: 0xb6 / 255, blue: 0x68 / 255, alpha: 1)
            if let outline {
                let path = UIBezierPath(roundedRect: outline.insetBy(dx: -3, dy: -3), cornerRadius: 8)
                path.lineWidth = 3
                amber.setStroke()
                path.stroke()
            }
            let marker = CGRect(x: pin.x - 15, y: pin.y - 15, width: 30, height: 30)
            amber.setFill()
            UIBezierPath(ovalIn: marker).fill()
            UIColor.black.setStroke()
            let ring = UIBezierPath(ovalIn: marker)
            ring.lineWidth = 2
            ring.stroke()
            let label = NSAttributedString(string: "\(number)", attributes: [
                .font: UIFont.systemFont(ofSize: 15, weight: .bold), .foregroundColor: UIColor.black,
            ])
            let size = label.size()
            label.draw(at: CGPoint(x: pin.x - size.width / 2, y: pin.y - size.height / 2))
        }
        return image.jpegData(compressionQuality: 0.75)
    }
}
