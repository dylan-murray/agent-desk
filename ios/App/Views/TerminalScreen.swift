import AgentDeskKit
import MoshKit
import SwiftTerm
import SwiftUI

/// A live terminal on the desk, over Mosh.
struct TerminalScreen: View {
    var hostID: UUID
    var sessionID: String
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller: TerminalController?
    @State private var dictating = false
    @AppStorage("terminalFontSize") private var fontSize = 12.0

    var body: some View {
        let connection = model.connection(hostID)
        let session = connection?.session(sessionID)
        VStack(spacing: 0) {
            if session?.isProtected == true {
                ContentUnavailableView {
                    Label("Protected session", systemImage: "lock.fill")
                } description: {
                    Text("Only the desk itself can read or type into this session. To use it from your phone, turn off its lock in the pane's header on the desk.")
                }
            } else if let controller {
                StatusBanner(phase: controller.phase, retry: controller.retry)
                ZStack {
                    GeometryReader { space in
                        // Whole rows only: SwiftTerm pins the last row to the bottom, so a height
                        // between rows would show a sliver of scrollback above the first one.
                        let row = Self.rowHeight(fontSize)
                        TerminalHost(controller: controller, fontSize: fontSize)
                            .frame(width: space.size.width, height: max(row, (space.size.height / row).rounded(.down) * row))
                    }
                    if controller.phase == .starting {
                        ProgressView("Attaching…").tint(Theme.ink2).foregroundStyle(Theme.ink2)
                    }
                }
                if let menu = controller.approval, session?.isRunning != false {
                    ApprovalBar(menu: menu, question: session?.question) { controller.send($0) }
                }
            }
        }
        .background(SwiftUI.Color(hex: 0x0c0c0d))
        .navigationTitle(session?.name ?? "Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.surface, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(session?.name ?? "Terminal").font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let session {
                        Text([session.project, harnessName(session.harness)].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                    }
                }
            }
            if session?.isProtected != true {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { dictating = true } label: { Image(systemName: "mic") }
                        .accessibilityLabel("Dictate")
                        .disabled(controller?.phase != .live(.connected))
                    Menu {
                        Button("Larger text", systemImage: "textformat.size.larger") { fontSize = min(fontSize + 1, 20) }
                        Button("Smaller text", systemImage: "textformat.size.smaller") { fontSize = max(fontSize - 1, 8) }
                        Divider()
                        Button("Send Ctrl-C", systemImage: "xmark.octagon") { controller?.send([0x03]) }
                        Button("Send Esc", systemImage: "escape") { controller?.send([0x1b]) }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("Terminal options")
                }
            }
        }
        .sheet(isPresented: $dictating) {
            DictationSheet { text in controller?.send(text) }
                .presentationDetents([.height(260)])
        }
        .task {
            guard controller == nil, let connection, session?.isProtected != true else { return }
            let controller = TerminalController(sessionID: sessionID, connection: connection)
            self.controller = controller
            await controller.start()
        }
        .onDisappear { controller?.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { controller?.resume() }
        }
    }
}

extension TerminalScreen {
    /// SwiftTerm's cell height for this font size, computed the way SwiftTerm does.
    static func rowHeight(_ size: Double) -> CGFloat {
        let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        return ceil(font.ascender - font.descender + font.leading)
    }
}

/// Connection trouble, said plainly, above the terminal. Silent while all is well.
private struct StatusBanner: View {
    var phase: TerminalController.Phase
    var retry: () -> Void

    var body: some View {
        Group {
            switch phase {
            case .failed(let message):
                banner(icon: "exclamationmark.triangle.fill", color: Theme.danger, text: message, action: ("Retry", retry))
            case .live(.unreachable(let since)):
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    banner(icon: "wifi.exclamationmark", color: Theme.amber,
                           text: "No contact for \(Int(context.date.timeIntervalSince(since)))s. Typing is kept and sent when the connection returns.")
                }
            case .live(.closed(.serverExited)):
                banner(icon: "checkmark.circle", color: Theme.completed, text: "This session has ended.")
            default:
                EmptyView()
            }
        }
        .animation(.default, value: phase)
    }

    private func banner(icon: String, color: SwiftUI.Color, text: String, action: (String, () -> Void)? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color)
            Text(text).font(.footnote).foregroundStyle(Theme.ink2).frame(maxWidth: .infinity, alignment: .leading)
            if let action {
                Button(action.0, action: action.1).font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }
}

/// One-tap answers for the approval menu on screen.
private struct ApprovalBar: View {
    var menu: ApprovalMenu
    var question: String?
    var send: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let question {
                Text(question).font(.footnote.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(2)
            }
            HStack(spacing: 10) {
                Button { send(menu.yes) } label: {
                    Label(menu.yesLabel, systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.working.opacity(0.85))
                .accessibilityIdentifier("approve")
                Button { send(menu.no) } label: {
                    Label(menu.noLabel, systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(Theme.danger)
                .accessibilityIdentifier("reject")
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
        }
        .padding(12)
        .background(Theme.surface)
        .overlay(alignment: .top) { Rectangle().fill(Theme.amber.opacity(0.5)).frame(height: 1) }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// SwiftTerm's terminal view, fed by the controller and typing into it.
private struct TerminalHost: UIViewRepresentable {
    var controller: TerminalController
    var fontSize: Double

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
        view.terminalDelegate = context.coordinator
        view.nativeBackgroundColor = UIColor(hex: 0x0c0c0d)
        view.nativeForegroundColor = UIColor(hex: 0xf5f5f4)
        view.caretColor = UIColor(hex: 0x9ccaff)
        view.keyboardAppearance = .dark
        view.optionAsMetaKey = true
        // SwiftUI already lays the terminal out below the navigation bar; UIKit's automatic
        // inset would push the first rows under it.
        view.contentInsetAdjustmentBehavior = .never
        controller.view = view
        DispatchQueue.main.async { _ = view.becomeFirstResponder() }
        return view
    }

    func updateUIView(_ view: TerminalView, context: Context) {
        if abs(view.font.pointSize - fontSize) > 0.1 {
            view.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        }
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        let controller: TerminalController

        init(controller: TerminalController) { self.controller = controller }

        func send(source: TerminalView, data: ArraySlice<UInt8>) { controller.send(Array(data)) }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { controller.resized(cols: newCols, rows: newRows) }
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link), ["http", "https"].contains(url.scheme) { UIApplication.shared.open(url) }
        }
        func bell(source: TerminalView) { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        func clipboardCopy(source: TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) { UIPasteboard.general.string = text }
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

/// Speak, then the words are typed into the terminal without pressing Return.
struct DictationSheet: View {
    var deliver: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    private var dictation = Dictation.shared

    init(deliver: @escaping (String) -> Void) {
        self.deliver = deliver
    }

    var body: some View {
        VStack(spacing: 18) {
            switch dictation.state {
            case .downloading(let fraction):
                ProgressView(value: fraction) { Text("Downloading the speech model, once") }
                    .tint(Theme.accent)
                Text("About 140 MB. Speech stays on this iPhone.").font(.caption).foregroundStyle(Theme.muted)
            case .loading:
                ProgressView("Preparing the speech model…")
            case .listening:
                LevelMeter(level: dictation.level)
                Text("Listening").font(.headline)
                Button {
                    Task {
                        let text = await dictation.finish()
                        if !text.isEmpty { deliver(text) }
                        dismiss()
                    }
                } label: {
                    Label("Done", systemImage: "stop.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            case .transcribing:
                ProgressView("Transcribing…")
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.danger).font(.footnote)
                Button("Close") { dictation.dismissError(); dismiss() }
            case .idle:
                ProgressView()
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.surface)
        .task { await dictation.start() }
        .onDisappear { dictation.cancel() }
    }
}

private struct LevelMeter: View {
    var level: Float

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<12, id: \.self) { index in
                let lit = Float(index) / 12 < level * 1.4
                Capsule()
                    .fill(lit ? Theme.markTop : Theme.raised)
                    .frame(width: 6, height: 10 + CGFloat(min(index, 11 - index)) * 4)
            }
        }
        .animation(.easeOut(duration: 0.1), value: level)
    }
}
