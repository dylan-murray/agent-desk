import AVFoundation
import Foundation
import Observation
import WhisperKit

/// On-device speech to text with Whisper. The model downloads once, on first use, and
/// nothing said ever leaves the phone.
@MainActor
@Observable
final class Dictation {
    static let shared = Dictation()
    /// English-only base model: a good balance of accuracy and size (about 140 MB) for prompts.
    static let model = "openai_whisper-base.en"

    enum State: Equatable {
        case idle
        case downloading(Double)
        case loading
        case listening
        case transcribing
        case failed(String)
    }

    private(set) var state = State.idle
    /// Recent loudness, 0 to 1, for the level meter.
    private(set) var level: Float = 0
    private var whisper: WhisperKit?
    private var meter: Task<Void, Never>?

    var isBusy: Bool {
        switch state {
        case .idle, .failed: false
        default: true
        }
    }

    func start() async {
        guard !isBusy else { return }
        do {
            guard await AudioProcessor.requestRecordPermission() else {
                state = .failed("Allow microphone access for Agent Desk in Settings to dictate.")
                return
            }
            let whisper = try await loaded()
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
            try AVAudioSession.sharedInstance().setActive(true)
            whisper.audioProcessor.purgeAudioSamples(keepingLast: 0)
            try whisper.audioProcessor.startRecordingLive(inputDeviceID: nil, callback: nil)
            state = .listening
            meter = Task { [weak self] in
                while !Task.isCancelled {
                    if let energy = self?.whisper?.audioProcessor.relativeEnergy.last { self?.level = energy }
                    try? await Task.sleep(for: .milliseconds(80))
                }
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Stops listening and returns what was said.
    func finish() async -> String {
        guard state == .listening, let whisper else { return "" }
        meter?.cancel()
        whisper.audioProcessor.stopRecording()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        level = 0
        state = .transcribing
        let samples = Array(whisper.audioProcessor.audioSamples)
        defer { if state == .transcribing { state = .idle } }
        do {
            return try await transcribe(samples)
        } catch {
            state = .failed(error.localizedDescription)
            return ""
        }
    }

    /// Text for 16 kHz mono samples; a quarter second or less is not speech.
    func transcribe(_ samples: [Float]) async throws -> String {
        guard samples.count > 16_000 / 4 else { return "" }
        let options = DecodingOptions(language: "en", skipSpecialTokens: true, withoutTimestamps: true)
        let results = try await loaded().transcribe(audioArray: samples, decodeOptions: options)
        return Self.clean(results.map(\.text).joined(separator: " "))
    }

    func cancel() {
        meter?.cancel()
        whisper?.audioProcessor.stopRecording()
        level = 0
        if state == .listening { state = .idle }
    }

    func dismissError() {
        if case .failed = state { state = .idle }
    }

    /// Whisper marks silence and noise in brackets; none of that belongs in a prompt.
    static func clean(_ text: String) -> String {
        text.replacing(/\[[A-Z_ ]+\]|\([a-z ]+\)/, with: "")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    func loaded() async throws -> WhisperKit {
        if let whisper { return whisper }
        state = .downloading(0)
        let folder = try await WhisperKit.download(variant: Self.model) { [weak self] progress in
            let fraction = progress.fractionCompleted
            Task { @MainActor in self?.state = .downloading(fraction) }
        }
        state = .loading
        defer { if state == .loading { state = .idle } }
        let whisper = try await WhisperKit(WhisperKitConfig(modelFolder: folder.path, verbose: false, prewarm: true, load: true,
                                                            download: false))
        self.whisper = whisper
        return whisper
    }
}
