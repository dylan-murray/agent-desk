import AgentDeskKit
import SwiftUI
import UIKit

/// A window above the app, its sheets included, that holds the annotation controls. Touches go
/// through to the app except on those controls, or everywhere while a pin is being placed.
final class AnnotationWindow: UIWindow {
    var interactive: [CGRect] = []
    var capturesAll = false

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard capturesAll || interactive.contains(where: { $0.contains(point) }) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// Keeps the status bar as the app has it while the overlay is on top.
private final class OverlayController<Content: View>: UIHostingController<Content> {
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}

@MainActor
enum AnnotationOverlay {
    private static var window: AnnotationWindow?

    static func install(over appWindow: UIWindow, model: AppModel) {
        AnnotationTargets.shared.appWindow = appWindow
        guard window == nil, let scene = appWindow.windowScene else { return }
        let overlay = AnnotationWindow(windowScene: scene)
        overlay.windowLevel = .normal + 10
        let controller = OverlayController(rootView: AnnotationLayer(window: overlay).environment(model))
        controller.view.backgroundColor = .clear
        overlay.rootViewController = controller
        overlay.isHidden = false
        window = overlay
    }

    static func remove() {
        Annotations.shared.mode = .idle
        window?.isHidden = true
        window = nil
    }

    /// Gives the keyboard back to the app once a note is written.
    static func returnFocus() {
        AnnotationTargets.shared.appWindow?.makeKey()
    }
}

/// The annotation controls, drawn in the overlay window.
private struct AnnotationLayer: View {
    let window: AnnotationWindow
    private var annotations = Annotations.shared

    init(window: AnnotationWindow) {
        self.window = window
    }

    var body: some View {
        ZStack {
            switch annotations.mode {
            case .idle:
                IdleControls(window: window)
            case .pinning:
                PinningLayer()
            case .composing(let draft):
                Composer(draft: draft)
            case .reviewing:
                ReviewPanel()
            }
        }
        .preferredColorScheme(.dark)
        .tint(Theme.accent)
        .onChange(of: annotations.mode, initial: true) { _, mode in
            window.capturesAll = mode != .idle
            if mode == .idle { AnnotationOverlay.returnFocus() }
        }
    }
}

/// The button that starts annotating, and the outcome of the last submission.
private struct IdleControls: View {
    let window: AnnotationWindow
    private var annotations = Annotations.shared
    @State private var frames: [String: CGRect] = [:]

    init(window: AnnotationWindow) {
        self.window = window
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Spacer()
            if let outcome = annotations.outcome {
                Text(outcome)
                    .font(.footnote)
                    .foregroundStyle(Theme.ink)
                    .padding(12)
                    .frame(maxWidth: 300, alignment: .leading)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.borderStrong))
                    .onTapGesture { annotations.dismissOutcome() }
                    .reportFrame("outcome", into: $frames)
                    .task {
                        try? await Task.sleep(for: .seconds(6))
                        annotations.dismissOutcome()
                    }
            }
            Button {
                annotations.dismissOutcome()
                annotations.mode = .pinning
            } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(width: 46, height: 46)
                    .background(Theme.raised.opacity(0.92), in: Circle())
                    .overlay(Circle().strokeBorder(Theme.borderStrong))
                    .overlay(alignment: .topTrailing) {
                        if !annotations.notes.isEmpty {
                            Text("\(annotations.notes.count)")
                                .font(.caption2.weight(.bold).monospacedDigit())
                                .foregroundStyle(.black)
                                .frame(minWidth: 18, minHeight: 18)
                                .background(Theme.amber, in: Capsule())
                                .offset(x: 4, y: -4)
                        }
                    }
                    .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(annotations.notes.isEmpty ? "Annotate" : "Annotate, \(annotations.notes.count) saved")
            .accessibilityIdentifier("annotate")
            .reportFrame("button", into: $frames)
        }
        .padding(.leading, 14)
        .padding(.bottom, 110)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .onChange(of: frames, initial: true) { _, frames in window.interactive = Array(frames.values) }
        .onDisappear { window.interactive = [] }
    }
}

/// Waiting for the tap that places a pin.
private struct PinningLayer: View {
    private var annotations = Annotations.shared

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.12)
                .contentShape(Rectangle())
                .onTapGesture(coordinateSpace: .global) { annotations.pin(at: $0) }
                .accessibilityIdentifier("annotation-canvas")
                .ignoresSafeArea()
            HStack(spacing: 10) {
                Image(systemName: "hand.tap")
                    .foregroundStyle(Theme.amber)
                Text("Tap what should change")
                    .font(.subheadline.weight(.medium))
                Spacer(minLength: 4)
                if !annotations.notes.isEmpty {
                    Button("Review \(annotations.notes.count)") { annotations.mode = .reviewing }
                        .font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("annotations-review")
                }
                Button("Done") { annotations.mode = .idle }
                    .font(.subheadline)
            }
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Theme.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.borderStrong))
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }
    }
}

/// Writing the note for a pin just placed.
private struct Composer: View {
    @State var draft: Annotations.Draft
    @FocusState private var focused: Bool
    @State private var dictating = false
    private var annotations = Annotations.shared

    init(draft: Annotations.Draft) {
        _draft = State(initialValue: draft)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.black.opacity(0.35).ignoresSafeArea()
            if let frame = draft.target?.frame {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Theme.amber, lineWidth: 2.5)
                    .frame(width: frame.width + 6, height: frame.height + 6)
                    .position(x: frame.midX, y: frame.midY)
                    .ignoresSafeArea()
            }
            PinMarker(number: annotations.notes.count + 1)
                .position(draft.point)
                .ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(draft.target.map { [$0.id, $0.detail].compactMap { $0 }.joined(separator: " · ") } ?? "This spot on the screen")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                    Text(draft.target?.source ?? draft.screen)
                        .font(.caption.monospaced())
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
                TextField("What should change?", text: $draft.text, axis: .vertical)
                    .lineLimit(3...6)
                    .focused($focused)
                    .padding(10)
                    .background(Theme.page, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityIdentifier("annotation-text")
                HStack(spacing: 10) {
                    Button { dictating = true } label: { Image(systemName: "mic") }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("Dictate")
                    Spacer()
                    Button("Discard", role: .destructive) { annotations.mode = .pinning }
                        .buttonStyle(.bordered)
                        .tint(Theme.danger)
                    Button("Save") { annotations.save(draft) }
                        .buttonStyle(.borderedProminent)
                        .disabled(draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("annotation-save")
                }
            }
            .padding(16)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.borderStrong))
            .padding(12)
        }
        .onAppear { focused = true }
        .sheet(isPresented: $dictating) {
            DictationSheet { text in draft.text = draft.text.isEmpty ? text : draft.text + " " + text }
                .presentationDetents([.height(260)])
        }
    }
}

private struct PinMarker: View {
    var number: Int

    var body: some View {
        Text("\(number)")
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(.black)
            .frame(width: 30, height: 30)
            .background(Theme.amber, in: Circle())
            .overlay(Circle().strokeBorder(.black, lineWidth: 2))
            .accessibilityHidden(true)
    }
}

/// The saved notes, and where to send them.
private struct ReviewPanel: View {
    @Environment(AppModel.self) private var model
    private var annotations = Annotations.shared

    private var choices: [(connection: DeskConnection, session: Session)] {
        model.openConnections.flatMap { connection in
            connection.sessions.filter(\.acceptsFeedback).map { (connection, $0) }
        }
    }

    private var chosen: (connection: DeskConnection, session: Session)? {
        guard let destination = annotations.destination else { return nil }
        return choices.first { $0.connection.host.id == destination.host && $0.session.id == destination.session }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(annotations.notes) { saved in
                        NoteRow(saved: saved, number: annotations.number(of: saved.id))
                    }
                    .onDelete { offsets in
                        for index in offsets { annotations.delete(annotations.notes[index].id) }
                    }
                } footer: {
                    Text("Each note goes with its screenshot, the screen, and the view it was pinned to with its source file and line.")
                }
                Section {
                    Menu {
                        ForEach(choices, id: \.session.id) { choice in
                            Button("\(choice.session.name) · \(choice.session.project ?? "") · \(choice.connection.host.name)") {
                                annotations.choose(.init(host: choice.connection.host.id, session: choice.session.id))
                            }
                        }
                    } label: {
                        LabeledContent {
                            Text(chosen?.session.name ?? (choices.isEmpty ? "No agents" : "Choose an agent"))
                                .foregroundStyle(chosen == nil ? Theme.muted : Theme.ink2)
                        } label: {
                            Text("Send to").foregroundStyle(Theme.ink)
                        }
                    }
                    .disabled(choices.isEmpty)
                    .accessibilityIdentifier("annotations-destination")
                } footer: {
                    Text(choices.isEmpty
                         ? "Open a desk with a Claude, Codex, Grok, OpenCode or Pi session running at the top level. Workers take feedback through their coordinator."
                         : "The desk types the notes into that agent's prompt, or holds them until the prompt is empty.")
                }
                if let outcome = annotations.outcome {
                    Section { Text(outcome).font(.footnote).foregroundStyle(Theme.ink2) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.page)
            .navigationTitle("Annotations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Add more") { annotations.mode = .pinning }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if annotations.sending {
                        ProgressView()
                    } else {
                        Button("Send") {
                            guard let chosen else { return }
                            Task { await annotations.send(through: chosen.connection, to: chosen.session) }
                        }
                        .disabled(chosen == nil || annotations.notes.isEmpty)
                        .accessibilityIdentifier("annotations-send")
                    }
                }
            }
        }
    }
}

private struct NoteRow: View {
    var saved: Annotations.Saved
    var number: Int

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let image = Annotations.shared.screenshot(for: saved) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 54, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.border))
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    PinMarker(number: number).scaleEffect(0.7).frame(width: 22, height: 22)
                    Text(saved.note.screen).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Text(saved.note.note).font(.subheadline).foregroundStyle(Theme.ink)
                if let element = saved.note.element {
                    Text("\(element.id) · \(element.source)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

private extension View {
    func reportFrame(_ key: String, into frames: Binding<[String: CGRect]>) -> some View {
        onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frames.wrappedValue[key] = $0 }
            .onDisappear { frames.wrappedValue[key] = nil }
    }
}
