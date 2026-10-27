import AgentDeskKit
import SwiftUI

struct HostEditor: View {
    @State var host: DeskHost
    var isNew: Bool
    var save: (DeskHost) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showAdvanced = false

    private var valid: Bool {
        !host.hostname.trimmingCharacters(in: .whitespaces).isEmpty && !host.username.trimmingCharacters(in: .whitespaces).isEmpty
            && (1...65535).contains(host.sshPort) && (1...65535).contains(host.deskPort)
            && !host.agentDeskCommand.trimmingCharacters(in: .whitespaces).isEmpty
            && !host.moshServerCommand.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    field("Name", text: $host.name, prompt: "Studio Mac", id: "host-name", plain: true)
                        .annotationTarget("HostEditorName")
                    field("Host", text: $host.hostname, prompt: "mac.tail1234.ts.net", id: "host-hostname")
                        .keyboardType(.URL)
                        .annotationTarget("HostEditorHost")
                    field("User", text: $host.username, prompt: "you", id: "host-user")
                        .annotationTarget("HostEditorUser")
                } footer: {
                    Text("The machine running Agent Desk, as you would reach it with ssh.")
                }

                Section {
                    if showAdvanced {
                        LabeledContent("SSH port") {
                            TextField("22", value: $host.sshPort, format: .number.grouping(.never))
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numberPad)
                                .accessibilityIdentifier("host-ssh-port")
                        }
                        LabeledContent("Agent Desk port") {
                            TextField("4310", value: $host.deskPort, format: .number.grouping(.never))
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.numberPad)
                                .accessibilityIdentifier("host-desk-port")
                        }
                        command("Agent Desk command", text: $host.agentDeskCommand, prompt: "agent-desk", id: "host-agent-desk-command")
                        command("mosh-server command", text: $host.moshServerCommand, prompt: "mosh-server", id: "host-mosh-command")
                        if host.hostKey != nil {
                            Button("Forget the pinned server key", role: .destructive) { host.hostKey = nil }
                        }
                    }
                } header: {
                    Button {
                        withAnimation { showAdvanced.toggle() }
                    } label: {
                        HStack {
                            Text("Advanced")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("advanced")
                } footer: {
                    if showAdvanced {
                        Text("Commands run in your login shell on the server. Use full paths if they are not on its PATH.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.page)
            .navigationTitle(isNew ? "Add a desk" : "Edit desk")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var saved = host
                        saved.hostname = saved.hostname.trimmingCharacters(in: .whitespaces)
                        saved.username = saved.username.trimmingCharacters(in: .whitespaces)
                        if saved.name.trimmingCharacters(in: .whitespaces).isEmpty { saved.name = saved.hostname }
                        save(saved)
                        dismiss()
                    }
                    .disabled(!valid)
                }
            }
        }
        .presentationBackground(Theme.page)
    }

    /// A labeled row, so a filled-in field still says what it is.
    private func field(_ label: String, text: Binding<String>, prompt: String, id: String, plain: Bool = false) -> some View {
        LabeledContent(label) {
            TextField(label, text: text, prompt: Text(prompt))
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(plain ? .words : .never)
                .autocorrectionDisabled(!plain)
                .accessibilityIdentifier(id)
        }
    }

    private func command(_ label: String, text: Binding<String>, prompt: String, id: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
            TextField(label, text: text, prompt: Text(prompt))
                .font(Theme.mono)
                .foregroundStyle(Theme.ink2)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier(id)
        }
        .padding(.vertical, 2)
    }
}
