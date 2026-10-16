import SwiftUI

/// Tools for people working on this app. Everything here is off until turned on.
struct DeveloperView: View {
    @AppStorage(DeveloperSettings.annotationsKey) private var annotating = false

    var body: some View {
        Form {
            Section {
                Toggle("Annotate this app", isOn: $annotating)
                    .accessibilityIdentifier("developer-annotations")
            } footer: {
                Text("Adds a button to every screen. Tap it, then tap what should change and say how. Notes go to a coding agent on your desk with a screenshot, the screen, and the view you pinned, including its Swift file and line, the way the desk's annotation tools send feedback from the browser.")
            }
            Section("How it reaches an agent") {
                Label("Notes stay on this iPhone until you send them.", systemImage: "iphone")
                Label("Sending goes over this desk's SSH login, like everything else.", systemImage: "lock")
                Label("The desk types them into the agent's prompt, or waits until it is empty.", systemImage: "text.cursor")
            }
            .font(.footnote)
            .foregroundStyle(Theme.ink2)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.page)
        .navigationTitle("Developer")
        .navigationBarTitleDisplayMode(.inline)
    }
}
