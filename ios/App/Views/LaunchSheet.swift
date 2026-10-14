import AgentDeskKit
import SwiftUI

/// Starts an agent on the desk, with the same choices as the desk's own launch dialog.
struct LaunchSheet: View {
    var connection: DeskConnection
    var info: DeskInfo
    var opened: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choice: String
    @State private var project: Project?
    @State private var desk: String
    @State private var prompt = ""
    @State private var launching = false
    @State private var error: String?
    @State private var dictating = false
    @AppStorage("lastLaunchChoice") private var lastChoice = ""
    @AppStorage("lastLaunchProject") private var lastProject = ""

    init(connection: DeskConnection, info: DeskInfo, desk: String?, opened: @escaping (String) -> Void) {
        self.connection = connection
        self.info = info
        self.opened = opened
        let remembered = UserDefaults.standard.string(forKey: "lastLaunchChoice") ?? ""
        _choice = State(initialValue: info.launchChoices.contains { $0.key == remembered }
            ? remembered : (info.launchChoices.first { $0.harness != "shell" } ?? info.launchChoices.first)?.key ?? "shell")
        let rememberedProject = UserDefaults.standard.string(forKey: "lastLaunchProject")
        _project = State(initialValue: info.projects.first { $0.path == rememberedProject })
        _desk = State(initialValue: desk ?? info.desks.first?.id ?? "main")
    }

    private var selected: LaunchChoice? { info.launchChoices.first { $0.key == choice } }
    private var isShell: Bool { selected?.harness == "shell" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Agent", selection: $choice) {
                        ForEach(info.launchChoices) { option in
                            Text(option.label).tag(option.key)
                        }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("launch-agent")
                    NavigationLink {
                        ProjectPicker(projects: info.projects, selection: $project)
                    } label: {
                        LabeledContent("Project") {
                            Text(project?.name ?? "Choose").foregroundStyle(project == nil ? Theme.muted : Theme.ink2)
                        }
                    }
                    .accessibilityIdentifier("launch-project")
                    if info.desks.count > 1 {
                        Picker("Desk", selection: $desk) {
                            ForEach(info.desks) { Text($0.name).tag($0.id) }
                        }
                    }
                }

                if !isShell {
                    Section {
                        TextField("What should it do?", text: $prompt, axis: .vertical)
                            .lineLimit(3...8)
                        Button {
                            dictating = true
                        } label: {
                            Label("Dictate", systemImage: "mic")
                        }
                    } header: {
                        Text("First prompt")
                    } footer: {
                        Text("Optional. It is sent as the agent's first message.")
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(Theme.danger).font(.footnote) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.page)
            .navigationTitle("Launch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if launching {
                        ProgressView()
                    } else {
                        Button("Launch", action: launch).disabled(project == nil)
                    }
                }
            }
            .sheet(isPresented: $dictating) {
                DictationSheet { text in prompt = prompt.isEmpty ? text : prompt + " " + text }
                    .presentationDetents([.height(260)])
            }
        }
        .presentationBackground(Theme.page)
    }

    private func launch() {
        guard let project else { return }
        launching = true
        error = nil
        Task {
            defer { launching = false }
            do {
                let client = try await connection.ready()
                let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                let id = try await client.launch(LaunchRequest(choice: choice, cwd: project.path, desk: desk,
                                                               prompt: isShell || text.isEmpty ? nil : text))
                lastChoice = choice
                lastProject = project.path
                dismiss()
                opened(id)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

private struct ProjectPicker: View {
    var projects: [Project]
    @Binding var selection: Project?
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var matches: [Project] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        return query.isEmpty ? projects : projects.filter { $0.name.lowercased().contains(query) || $0.path.lowercased().contains(query) }
    }

    var body: some View {
        List(matches) { project in
            Button {
                selection = project
                dismiss()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name).foregroundStyle(Theme.ink)
                        Text(project.path).font(.caption).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head)
                    }
                    Spacer()
                    if project == selection { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                }
            }
            .accessibilityIdentifier("project-\(project.name)")
        }
        .scrollContentBackground(.hidden)
        .background(Theme.page)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search projects")
        .overlay {
            if matches.isEmpty {
                ContentUnavailableView(projects.isEmpty ? "No projects found" : "No matches", systemImage: "folder",
                                       description: Text(projects.isEmpty
                                                         ? "The desk looks for git repositories under ~/projects, ~/code, ~/src and similar folders."
                                                         : "Try another name."))
            }
        }
        .navigationTitle("Project")
        .navigationBarTitleDisplayMode(.inline)
    }
}
