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
