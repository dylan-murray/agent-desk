import AgentDeskKit
import SwiftUI

@main
struct AgentDeskApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    private static let hostingUnitTests = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    var body: some Scene {
        WindowGroup {
            if Self.hostingUnitTests {
                // Unit tests run inside the app and test its types, not its screens. Opening a saved
                // desk would start a Live Activity that outlives the run, and on the next install
                // ActivityKit relaunches the app in the background, before the test bundle is in it.
                Color.clear
            } else {
                RootView()
                    .environment(model)
                    .preferredColorScheme(.dark)
                    .tint(Theme.accent)
                    .onOpenURL { model.open($0) }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.becameActive()
            case .background: model.movedToBackground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var openedOnlyHost = false
    @State private var window: UIWindow?
    @AppStorage(DeveloperSettings.annotationsKey) private var annotating = false

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            HostsView()
                .navigationDestination(for: AppModel.Route.self) { route in
                    switch route {
                    case .host(let id): SessionsView(hostID: id)
                    case .terminal(let host, let session): TerminalScreen(hostID: host, sessionID: session)
                    case .phoneKey: PhoneKeyView()
                    case .developer: DeveloperView()
                    }
                }
        }
        .background(Theme.page)
        .background(WindowReader(window: $window))
        .onChange(of: [annotating, window != nil], initial: true) {
            // Developer annotations live in a window of their own, above every sheet.
            guard let window else { return }
            if annotating {
                Annotations.shared.describeScreen = { [model] in model.describeScreen() }
                AnnotationOverlay.install(over: window, model: model)
            } else {
                AnnotationOverlay.remove()
            }
        }
        .onAppear {
            // With one desk there is nothing to choose: go straight to its sessions.
            guard !openedOnlyHost, model.path.isEmpty, model.hosts.count == 1, let only = model.hosts.first else { return }
            openedOnlyHost = true
            model.path = [.host(only.id)]
        }
    }
}

/// Finds the window SwiftUI put the app in.
private struct WindowReader: UIViewRepresentable {
    @Binding var window: UIWindow?

    func makeUIView(context: Context) -> Reader {
        let view = Reader()
        view.found = { window = $0 }
        return view
    }

    func updateUIView(_ view: Reader, context: Context) {}

    final class Reader: UIView {
        var found: ((UIWindow) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { DispatchQueue.main.async { [found] in found?(window) } }
        }
    }
}
