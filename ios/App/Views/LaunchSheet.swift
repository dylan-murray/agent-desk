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
    @State private var coordinating = false
    @State private var objective = LaunchSheet.defaultObjective
    @State private var routed = false
    @State private var launching = false
    @State private var error: String?
    @State private var dictating: DictationField?
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

    /// The browser's default objective for a new coordinator.
    static let defaultObjective = "Review the running agents, summarize their progress, and wait for my instructions."

    private enum DictationField: Identifiable {
        case prompt, objective
        var id: Self { self }
    }

    private var selected: LaunchChoice? { info.launchChoices.first { $0.key == choice } }
    private var isShell: Bool { selected?.harness == "shell" }
    /// A coordinator runs one of these, as in the desk's own dialog.
    private var choices: [LaunchChoice] {
        guard coordinating, let harnesses = info.coordinator?.harnesses else { return info.launchChoices }
        return info.launchChoices.filter { harnesses.contains($0.harness) }
    }
    private var canLaunch: Bool {
        project != nil && (!coordinating || !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Agent harness", selection: $choice) {
                        ForEach(choices) { option in
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

                if let options = info.coordinator {
                    Section {
                        Toggle("Coordinate other agents", isOn: $coordinating)
                            .accessibilityIdentifier("launch-coordinate")
                    } footer: {
                        if !coordinating {
                            Text("Launch it as a coordinator that starts and directs workers on this desk.")
                        }
                    }
                    if coordinating {
                        Section {
                            TextField("Coordinate the agents working on…", text: $objective, axis: .vertical)
                                .lineLimit(3...8)
                                .accessibilityIdentifier("launch-objective")
                            Button {
                                dictating = .objective
                            } label: {
                                Label("Dictate", systemImage: "mic")
                            }
                            if options.router {
                                Toggle("Pick each worker's model with the model router", isOn: $routed)
                                    .accessibilityIdentifier("launch-router")
                            }
                        } header: {
                            Text("Coordinator objective")
                        } footer: {
                            Text("It delegates tasks to workers it starts on this desk and stays available. Worker replies start its next turn.")
                        }
                    }
                }

                if !isShell && !coordinating {
                    Section {
                        TextField("What should it do?", text: $prompt, axis: .vertical)
                            .lineLimit(3...8)
                        Button {
                            dictating = .prompt
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
            .navigationTitle(coordinating ? "New coordinator" : "Launch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if launching {
                        ProgressView()
                    } else {
                        Button("Launch", action: launch).disabled(!canLaunch)
                    }
                }
            }
            .sheet(item: $dictating) { field in
                DictationSheet { text in
                    switch field {
                    case .prompt: prompt = prompt.isEmpty ? text : prompt + " " + text
                    case .objective: objective = objective.isEmpty ? text : objective + " " + text
                    }
                }
                .presentationDetents([.height(260)])
            }
            .onChange(of: coordinating) {
                // As at the desk: a shell or another CLI cannot coordinate, so Claude stands in.
                if !choices.contains(where: { $0.key == choice }) {
                    choice = (choices.first { $0.harness == "claude" } ?? choices.first)?.key ?? choice
                }
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
                let coordinator = coordinating
                    ? LaunchRequest.Coordinator(objective: objective.trimmingCharacters(in: .whitespacesAndNewlines), router: routed)
                    : nil
                let id = try await client.launch(LaunchRequest(choice: choice, cwd: project.path, desk: desk,
                                                               prompt: isShell || coordinating || text.isEmpty ? nil : text,
                                                               coordinator: coordinator))
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
