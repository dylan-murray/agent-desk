import WhisperKit
import XCTest
@testable import Agent_Desk

/// Downloads the Whisper model on first run (about 140 MB) and transcribes recorded speech.
@MainActor
final class DictationTests: XCTestCase {
    func testSpeechBecomesPromptText() async throws {
        let path = try XCTUnwrap(Bundle(for: Self.self).path(forResource: "speech", ofType: "wav"))
        let samples = try AudioProcessor.loadAudioAsFloatArray(fromPath: path)
        let text = try await Dictation.shared.transcribe(samples)
        XCTAssertEqual(text.lowercased().filter { $0.isLetter || $0 == " " }, "run the test suite and fix any failures")
    }

    func testWhisperMarkersAreDropped() {
        XCTAssertEqual(Dictation.clean(" [BLANK_AUDIO] ship it  (wind blowing) now "), "ship it now")
    }
}
