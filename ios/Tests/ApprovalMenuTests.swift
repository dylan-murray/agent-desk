import XCTest
@testable import Agent_Desk

@MainActor
final class ApprovalMenuTests: XCTestCase {
    func testNumberedMenusAnswerWithTheOptionsDigit() throws {
        let screen = ["⏺ Bash(npm test)", "", "│ Do you want to proceed?", "│ ❯ 1. Yes",
                      "│   2. Yes, and don't ask again for npm run build", "│   3. No, and tell me what to do differently", "", ""]
        let menu = try XCTUnwrap(ApprovalMenu(screen: screen))
        XCTAssertEqual([menu.yes, menu.yesLabel, menu.no, menu.noLabel], ["1", "Yes", "3", "No"])
    }

    func testKeyPromptsAnswerWithYOrN() throws {
        let menu = try XCTUnwrap(ApprovalMenu(screen: ["Overwrite config.toml? [y/N]"]))
        XCTAssertEqual([menu.yes, menu.no], ["y", "n"])
    }

    func testOrdinaryOutputAndOldPromptsAreNotMenus() {
        XCTAssertNil(ApprovalMenu(screen: ["$ ls", "README.md  src", "$ "]))
        // A menu that scrolled up out of the last dozen lines was already answered.
        let old = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"] + (1...14).map { "line \($0)" }
        XCTAssertNil(ApprovalMenu(screen: old))
    }
}
