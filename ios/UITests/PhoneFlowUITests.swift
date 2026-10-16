import XCTest

/// The app end to end, as a person uses it, against a fixture desk on this Mac:
/// set up a desk, trust its key, answer an approval, type into a shell, launch an agent,
/// and see the Live Activity. Run it with scripts in ios/README.md, which start the desk and
/// an sshd and pass their details in E2E_* variables (TEST_RUNNER_E2E_* to xcodebuild).
@MainActor
final class PhoneFlowUITests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private let app = XCUIApplication()

    func testPhoneFlow() throws {
        continueAfterFailure = false
        try XCTSkipIf(env["E2E_SSH_PORT"] == nil, "Set TEST_RUNNER_E2E_* to run against a fixture desk")
        app.launch()

        // A first launch explains what to set up.
        XCTAssert(app.staticTexts["Your agents, from your phone"].waitForExistence(timeout: 15))
        shot("01-welcome")

        // The phone's key goes into the server's authorized_keys.
        app.buttons["phone-key-link"].tap()
        let key = app.textViews["phone-key"]
        let keyShown = key.waitForExistence(timeout: 15)
        shot("02-phone-key")
        XCTAssert(keyShown, app.debugDescription)
        let line = key.value as? String ?? ""
        XCTAssert(line.hasPrefix("ecdsa-sha2-nistp256 ") && line.hasSuffix(" agent-desk-iphone"), line)
        try (line + "\n").write(toFile: env["E2E_AUTHORIZED_KEYS"]!, atomically: true, encoding: .utf8)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Add the desk.
        app.buttons["Add a desk"].firstMatch.tap()
        fill("host-name", "Studio Mac")
        fill("host-hostname", "127.0.0.1")
        fill("host-user", env["E2E_USER"]!)
        app.buttons["advanced"].tap()
        fill("host-ssh-port", env["E2E_SSH_PORT"]!, replacing: true)
        fill("host-desk-port", env["E2E_DESK_PORT"]!, replacing: true)
        fill("host-agent-desk-command", env["E2E_COMMAND"]!, replacing: true)
        app.swipeDown()
        shot("03-add-desk")
        app.navigationBars.buttons["Save"].tap()

        // First connection: compare the fingerprint, then trust it.
        let trust = app.buttons["Trust this server"]
        let asked = trust.waitForExistence(timeout: 30)
        if !asked { shot("04-trust-missing") }
        XCTAssert(asked, app.debugDescription)
        XCTAssertEqual(app.textViews["fingerprint"].value as? String, env["E2E_FINGERPRINT"], "the fingerprint ssh-keygen prints")
        shot("04-trust")
        trust.tap()

        // The live session list, the waiting session first.
        let waiting = app.descendants(matching: .any)["session-Fix coupon total"].firstMatch
        XCTAssert(app.staticTexts["NEEDS YOU"].waitForExistence(timeout: 30))
        XCTAssert(waiting.exists)
        XCTAssert(app.staticTexts["RUNNING"].exists)
        sleep(2)
        shot("05-sessions")

        // Answer the approval with one tap.
        waiting.tap()
        let approve = app.buttons["approve"]
        XCTAssert(approve.waitForExistence(timeout: 30))
        sleep(1)
        shot("06-approval")
        approve.tap()
        XCTAssert(approve.waitForNonExistence(timeout: 15))
        sleep(2)
        shot("07-approved")
        back()

        // It no longer needs you.
        XCTAssert(app.staticTexts["NEEDS YOU"].waitForNonExistence(timeout: 30))

        // Type into a shell.
        app.descendants(matching: .any)["session-Shell"].firstMatch.tap()
        sleep(4)
        app.typeText("echo typed-on-the-phone-$((6*7))\n")
        sleep(2)
        shot("08-shell")
        back()

        // A session protected at the desk is listed, but stays there.
        app.descendants(matching: .any)["session-Docs links"].firstMatch.tap()
        XCTAssert(app.staticTexts["Protected session"].waitForExistence(timeout: 10))
        shot("08b-protected")
        back()

        // Developer annotations: turned on, a note pinned on a session row goes to an agent.
        back()
        app.buttons["developer-link"].tap()
        let toggle = app.switches["developer-annotations"]
        XCTAssert(toggle.waitForExistence(timeout: 5))
        // The switch itself, at the trailing end of the row.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssert(app.buttons["annotate"].waitForExistence(timeout: 5))
        shot("08c-developer")
        back()
        app.staticTexts["Studio Mac"].firstMatch.tap()
        let row = app.descendants(matching: .any)["session-Partial refunds"].firstMatch
        XCTAssert(row.waitForExistence(timeout: 20))
        app.buttons["annotate"].tap()
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let text = app.descendants(matching: .any)["annotation-text"].firstMatch
        XCTAssert(text.waitForExistence(timeout: 5))
        text.typeText("Show how long the session has been producing output")
        shot("09a-annotation-note")
        app.buttons["annotation-save"].tap()
        app.buttons["annotations-review"].tap()
        app.buttons["annotations-destination"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Partial refunds'")).firstMatch.tap()
        shot("09b-annotation-review")
        app.buttons["annotations-send"].tap()
        let queued = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '1 note queued for Partial refunds'")).firstMatch
        XCTAssert(queued.waitForExistence(timeout: 30))
        shot("09c-annotation-sent")
        // The desk saved the note with the view it was pinned to, and its screenshot beside it.
        let saved = try submittedNote(containing: "Show how long the session has been producing output")
        let element = try XCTUnwrap(saved["element"] as? [String: Any])
        XCTAssertEqual(element["id"] as? String, "SessionRow")
        XCTAssertEqual(element["detail"] as? String, "Partial refunds")
        XCTAssert((element["source"] as? String)?.wholeMatch(of: /SessionsView\.swift:\d+/) != nil, "\(element)")
        XCTAssertEqual(saved["screen"] as? String, "Sessions · Studio Mac")
        XCTAssert(FileManager.default.fileExists(atPath: try XCTUnwrap(saved["screenshot"] as? String)))

        // Launch a new agent into a project.
        app.navigationBars.buttons["Launch an agent"].tap()
        app.buttons["launch-agent"].tap()
        app.buttons["Shell"].firstMatch.tap()
        app.buttons["launch-project"].tap()
        app.buttons["project-mobile-shell"].firstMatch.tap()
        XCTAssert(app.buttons["launch-project"].label.contains("mobile-shell"), app.buttons["launch-project"].label)
        shot("09-launch")
        app.navigationBars.buttons["Launch"].tap()
        XCTAssert(app.navigationBars.staticTexts["Shell"].waitForExistence(timeout: 30))
        sleep(4)
        shot("10-launched")
        back()
        sleep(2)
        shot("11-sessions-after")

        // Launch a coordinator, as with the desk's "Coordinate other agents": a shell cannot coordinate, so Claude stands in.
        app.navigationBars.buttons["Launch an agent"].tap()
        let coordinate = app.switches["launch-coordinate"]
        XCTAssert(coordinate.waitForExistence(timeout: 10))
        coordinate.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(app.buttons["launch-agent"].value as? String, "Claude")
        XCTAssert(app.staticTexts["Coordinator objective"].exists)
        shot("11b-coordinator")
        app.navigationBars.buttons["Launch"].tap()
        let controller = app.navigationBars.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Controller · Claude'")).firstMatch
        XCTAssert(controller.waitForExistence(timeout: 30))
        back()

        // The Live Activity carries the desk to the Home Screen and Lock Screen.
        XCUIDevice.shared.press(.home)
        sleep(3)
        shot("12-dynamic-island")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.005))
            .press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.7)))
        sleep(3)
        shot("13-lock-screen")
    }

    /// The note the desk saved for its agent, from the desk's data directory.
    private func submittedNote(containing text: String) throws -> [String: Any] {
        let folder = URL(fileURLWithPath: try XCTUnwrap(env["E2E_DATA_DIR"])).appendingPathComponent("feedback-submissions")
        // Newest first: earlier runs may have sent the same words.
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter { $0.pathExtension == "json" }
            .sorted { modified($0) > modified($1) }
        for file in files {
            let notes = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]] ?? []
            if let note = notes.first(where: { ($0["note"] as? String) == text }) { return note }
        }
        return try XCTUnwrap(nil as [String: Any]?, "No submission with that note in \(folder.path)")
    }

    private func modified(_ file: URL) -> Date {
        (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    /// Every failure leaves a picture of what was on screen.
    override func record(_ issue: XCTIssue) {
        let name = "failure-\(issue.sourceCodeContext.location?.lineNumber ?? 0)"
        MainActor.assumeIsolated { Self.save(XCUIScreen.main.screenshot(), as: name) }
        super.record(issue)
    }

    private func fill(_ identifier: String, _ text: String, replacing: Bool = false) {
        let field = app.textFields[identifier]
        XCTAssert(field.waitForExistence(timeout: 5), identifier)
        field.tap()
        if replacing, let current = field.value as? String, !current.isEmpty {
            sleep(1)
            if current.allSatisfy(\.isNumber) {
                // A double-tap selects the whole number, and typing replaces it.
                field.doubleTap()
            } else {
                // Past the end of left-aligned text puts the cursor after it; then delete it all.
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
            }
        }
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text, identifier)
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        Self.save(screenshot, as: name)
    }

    private static func save(_ screenshot: XCUIScreenshot, as name: String) {
        guard let folder = ProcessInfo.processInfo.environment["E2E_SHOTS"] else { return }
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
    }
}
