import CoreGraphics
import Foundation

/// A note pinned on the app's own screen, in the shape the desk's annotation tools send: what
/// the person wants changed, where they pointed, and enough context to find it in the code.
public struct AnnotationNote: Codable, Equatable, Identifiable, Sendable {
    public struct Rect: Codable, Equatable, Sendable {
        public var x, y, width, height: Double

        public init(_ rect: CGRect) {
            (x, y, width, height) = (Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height))
        }
    }

    public struct Point: Codable, Equatable, Sendable {
        public var x, y: Double
    }

    /// The tagged view under the pin: its name, what it shows, and where it is written.
    public struct Element: Codable, Equatable, Sendable {
        public var id: String
        public var detail: String?
        /// "Views/SessionsView.swift:142", from the call site of the view's annotation tag.
        public var source: String
        public var frame: Rect

        public init(id: String, detail: String?, source: String, frame: CGRect) {
            self.id = id
            self.detail = detail
            self.source = source
            self.frame = Rect(frame)
        }
    }

    public struct Display: Codable, Equatable, Sendable {
        public var width, height, scale: Double
        public var appearance: String
        public var textSize: String

        public init(width: CGFloat, height: CGFloat, scale: CGFloat, appearance: String, textSize: String) {
            (self.width, self.height, self.scale) = (Double(width), Double(height), Double(scale))
            self.appearance = appearance
            self.textSize = textSize
        }
    }

    public var id: String
    public var note: String
    public var createdAt: String
    public var updatedAt: String?
    public var platform = "ios"
    /// Which app and build, so the agent knows which code the note is about.
    public var app: String
    public var screen: String
    public var element: Element?
    /// Where the pin is, in points from the top left of the screen.
    public var point: Point
    public var display: Display
    public var device: String
    public var system: String

    public init(id: String, note: String, createdAt: Date, app: String, screen: String, element: Element?, point: CGPoint,
                display: Display, device: String, system: String) {
        self.id = id
        self.note = note
        self.createdAt = createdAt.formatted(.iso8601)
        self.app = app
        self.screen = screen
        self.element = element
        self.point = Point(x: Double(point.x), y: Double(point.y))
        self.display = display
        self.device = device
        self.system = system
    }
}

/// What the desk did with a submission: typed into the agent's prompt, or queued until the agent
/// is at an empty prompt.
public struct FeedbackResult: Decodable, Equatable, Sendable {
    public var targetId: String?
    public var sent: Bool
    public var queued: Bool
    public var duplicate: Bool
}

extension DeskClient {
    /// Sends notes, each with an optional screenshot (JPEG or PNG), to a coding agent's session.
    /// Reusing a request ID for the same notes is safe: the desk delivers a submission once.
    public func sendFeedback(requestID: String, target: String, notes: [AnnotationNote],
                             screenshots: [String: Data]) async throws -> FeedbackResult {
        struct Request: Encodable {
            var request_id: String
            var target_id: String
            var notes: [AnnotationNote]
            var screenshots: [String: String]
        }
        let body = Request(request_id: requestID, target_id: target, notes: notes,
                           screenshots: screenshots.mapValues { $0.base64EncodedString() })
        let input = try JSONEncoder().encode(body)
        let result = try await connection.run(Remote.mobile(host, "feedback"), input: input)
        return try Remote.decodeAnswer(result, as: FeedbackResult.self, expecting: "feedback")
    }
}

extension Session {
    /// Whether the desk can deliver annotations for this session: to a coding agent at the top
    /// level, or for a worker, to its coordinator. The desk decides, by its browser's rule.
    public var acceptsFeedback: Bool { feedbackTarget != nil }
}
