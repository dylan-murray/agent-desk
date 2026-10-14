import AgentDeskKit
import XCTest
@testable import Agent_Desk

@MainActor
final class AnnotationTests: XCTestCase {
    private func target(_ id: String, _ frame: CGRect, layer: Int = 0) -> AnnotationTargets.Target {
        .init(id: id, detail: nil, source: "Views/Test.swift:1", frame: frame, layer: layer)
    }

    func testAPinLandsOnTheInnermostTaggedView() {
        let targets = AnnotationTargets()
        targets.update(UUID(), target("SessionList", CGRect(x: 0, y: 0, width: 400, height: 800)))
        targets.update(UUID(), target("SessionRow", CGRect(x: 16, y: 100, width: 368, height: 80)))
        XCTAssertEqual(targets.target(at: CGPoint(x: 50, y: 120))?.id, "SessionRow")
        XCTAssertEqual(targets.target(at: CGPoint(x: 50, y: 400))?.id, "SessionList")
        XCTAssertNil(targets.target(at: CGPoint(x: 500, y: 900)))
    }

    func testViewsOfASheetThatIsNotShowingAreIgnored() {
        // Without a presented sheet, a layer-1 view left over from one cannot win.
        let targets = AnnotationTargets()
        targets.update(UUID(), target("SessionRow", CGRect(x: 0, y: 0, width: 400, height: 100)))
        targets.update(UUID(), target("LaunchPrompt", CGRect(x: 0, y: 0, width: 100, height: 50), layer: 1))
        XCTAssertEqual(targets.target(at: CGPoint(x: 20, y: 20))?.id, "SessionRow")
    }

    func testTheSameNotesToTheSameAgentAlwaysMakeTheSameSubmission() {
        let note = AnnotationNote(id: "a", note: "Bigger", createdAt: Date(timeIntervalSince1970: 0), app: "Agent Desk iOS",
                                  screen: "Desks", element: nil, point: .zero,
                                  display: .init(width: 402, height: 874, scale: 3, appearance: "dark", textSize: "UICTContentSizeCategoryL"),
                                  device: "iPhone", system: "iOS 27.0")
        let first = Annotations.requestID([note], "terminal-1")
        XCTAssertEqual(first, Annotations.requestID([note], "terminal-1"))
        XCTAssertNotEqual(first, Annotations.requestID([note], "terminal-2"))
        XCTAssertTrue(first.wholeMatch(of: /ios-[0-9a-f]{32}/) != nil, first)
    }

    func testNotesUseTheShapeOfTheDesksAnnotations() throws {
        let note = AnnotationNote(id: "a", note: "Bigger", createdAt: Date(timeIntervalSince1970: 0), app: "Agent Desk iOS",
                                  screen: "Sessions · Studio Mac",
                                  element: .init(id: "SessionRow", detail: "Fix coupon total", source: "Views/SessionsView.swift:142",
                                                 frame: CGRect(x: 16, y: 100, width: 368, height: 80)),
                                  point: CGPoint(x: 50, y: 120),
                                  display: .init(width: 402, height: 874, scale: 3, appearance: "dark", textSize: "UICTContentSizeCategoryL"),
                                  device: "iPhone Simulator", system: "iOS 27.0")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(note)) as? [String: Any])
        // The desk requires id and note, and reads createdAt as the version of a note.
        XCTAssertEqual(json["id"] as? String, "a")
        XCTAssertEqual(json["note"] as? String, "Bigger")
        XCTAssertEqual(json["createdAt"] as? String, "1970-01-01T00:00:00Z")
        XCTAssertEqual(json["platform"] as? String, "ios")
        XCTAssertEqual((json["element"] as? [String: Any])?["source"] as? String, "Views/SessionsView.swift:142")
    }
}
