import AgentDeskKit
import SwiftUI

/// One desk's sessions, live: the ones that need you first.
struct SessionsView: View {
    var hostID: UUID
    @Environment(AppModel.self) private var model
    @State private var deskFilter: String?
    @State private var launching = false
    @State private var editing = false
    @State private var showExited = false

    var body: some View {
        if let connection = model.connection(hostID) {
            content(connection)
                .onAppear { connection.connect() }
        } else {
            ContentUnavailableView("This desk was removed", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
        }
    }

    @ViewBuilder
    private func content(_ connection: DeskConnection) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                switch connection.state {
                case .needsTrust(let key):
                    TrustCard(host: connection.host, key: key, trust: { connection.trust(key) })
                case .keyChanged(let expected, let presented):
                    KeyChangedCard(expected: expected, presented: presented)
                case .failed(let message):
                    FailureCard(message: message, retryIn: connection.retryIn, retry: connection.retryNow)
                case .idle, .connecting:
                    if connection.snapshot == nil {
                        ConnectingCard(host: connection.host)
                    }
                case .connected:
                    EmptyView()
                }
                if let snapshot = connection.snapshot {
                    sessionList(snapshot, connection: connection)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 30)
            .animation(.default, value: connection.snapshot?.sessions.map(\.id))
        }
        .background(Theme.page)
        .refreshable { connection.retryNow() }
        .navigationTitle(connection.host.name)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Edit desk", systemImage: "slider.horizontal.3") { editing = true }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("Desk options")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { launching = true } label: { Image(systemName: "plus") }
                    .disabled(connection.info == nil)
                    .accessibilityLabel("Launch an agent")
            }
        }
        .sheet(isPresented: $launching) {
            if let info = connection.info {
                LaunchSheet(connection: connection, info: info, desk: deskFilter) { id in
                    model.path.append(.terminal(host: hostID, session: id))
                }
            }
        }
        .sheet(isPresented: $editing) {
            HostEditor(host: connection.host, isNew: false) { saved in
                model.save(saved)
                connection.retryNow()
            }
        }
    }

    @ViewBuilder
    private func sessionList(_ snapshot: Snapshot, connection: DeskConnection) -> some View {
        let visible = snapshot.sessions.filter { deskFilter == nil || $0.desk == deskFilter }
        let waiting = visible.filter(\.needsInput)
        let running = visible.filter { $0.isRunning && !$0.needsInput }
        let exited = visible.filter { !$0.isRunning }

        if snapshot.desks.count > 1 {
            DeskPicker(desks: snapshot.desks, sessions: snapshot.sessions, selection: $deskFilter)
        }
        if visible.isEmpty {
            EmptyDesk(launch: { launching = true }, canLaunch: connection.info != nil)
        }
        if !waiting.isEmpty {
            group("Needs you", waiting, highlight: true)
        }
        if !running.isEmpty {
            group("Running", running)
        }
        if !exited.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation { showExited.toggle() }
                } label: {
                    HStack {
                        SectionLabel(text: "Exited", count: exited.count)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.muted)
                            .rotationEffect(.degrees(showExited ? 90 : 0))
                    }
                }
                .buttonStyle(.plain)
                if showExited {
                    ForEach(exited) { row($0) }
                }
            }
        }
        if !snapshot.ready, !visible.isEmpty {
            Text("Reading terminal screens for approval prompts…")
                .font(.caption)
                .foregroundStyle(Theme.muted)
        }
    }

    private func group(_ title: String, _ sessions: [Session], highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: title, count: sessions.count)
            ForEach(sessions) { row($0, highlight: highlight) }
        }
    }

    private func row(_ session: Session, highlight: Bool = false) -> some View {
        NavigationLink(value: AppModel.Route.terminal(host: hostID, session: session.id)) {
            SessionRow(session: session, highlight: highlight)
        }
        .buttonStyle(.plain)
    }
}

struct SessionRow: View {
    var session: Session
    var highlight = false

    var body: some View {
        let style = StatusStyle(session)
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                Text(String((harnessName(session.harness) ?? session.name).prefix(1)))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(harnessColor(session.harness))
                    .frame(width: 34, height: 34)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.border))
                StatusDot(style: style, size: 9)
                    .padding(2)
                    .background(Theme.surface, in: Circle())
                    .offset(x: 3, y: 3)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(session.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let age = relativeAge(session.lastOutput) {
                        Text(age).font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
                    }
                }
                Text([session.project, harnessName(session.harness), style.label].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(session.needsInput ? Theme.amber : Theme.muted)
                    .lineLimit(1)
                if session.needsInput, let question = session.question {
                    Text(question)
                        .font(.footnote)
                        .foregroundStyle(Theme.ink2)
                        .lineLimit(2)
                        .padding(.top, 2)
                }
            }
        }
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
            .strokeBorder(highlight ? Theme.amber.opacity(0.45) : Theme.border))
        .contentShape(RoundedRectangle(cornerRadius: 13))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("session-\(session.name)")
    }
}

private struct DeskPicker: View {
    var desks: [DeskRef]
    var sessions: [Session]
    @Binding var selection: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", id: nil, waiting: sessions.filter(\.needsInput).count)
                ForEach(desks) { desk in
                    chip(desk.name, id: desk.id, waiting: sessions.filter { $0.desk == desk.id && $0.needsInput }.count)
                }
            }
        }
    }

    private func chip(_ name: String, id: String?, waiting: Int) -> some View {
        let selected = selection == id
        return Button {
            selection = id
        } label: {
            HStack(spacing: 6) {
                Text(name)
                if waiting > 0 {
                    Circle().fill(Theme.amber).frame(width: 6, height: 6)
                }
            }
            .font(.subheadline.weight(selected ? .semibold : .regular))
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
            .foregroundStyle(selected ? Color(hex: 0xb4cff0) : Theme.ink2)
            .background(selected ? Theme.accent.opacity(0.14) : Theme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Color(hex: 0x35557b) : Theme.border))
        }
        .buttonStyle(.plain)
    }
}

private struct EmptyDesk: View {
    var launch: () -> Void
    var canLaunch: Bool

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "chevron.right.square")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Theme.lavender)
                .frame(width: 58, height: 58)
                .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(Color(hex: 0x4a3e5e)))
            Text("No sessions yet").font(.title3.weight(.medium))
            Text("Launch an agent here and it runs on the desk, where you can pick it up from the browser too.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Launch an agent", action: launch)
                .buttonStyle(.borderedProminent)
                .disabled(!canLaunch)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

private struct ConnectingCard: View {
    var host: DeskHost

    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text("Connecting to \(host.hostname)…").font(.subheadline).foregroundStyle(Theme.ink2)
            Spacer()
        }
        .card()
    }
}

private struct FailureCard: View {
    var message: String
    var retryIn: Int?
    var retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Can't reach this desk", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.danger)
            Text(message).font(.footnote).foregroundStyle(Theme.ink2).textSelection(.enabled)
            HStack {
                Button("Try again", action: retry).buttonStyle(.bordered)
                if let retryIn {
                    Text("Retrying in \(retryIn)s").font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// First connection: show the key's fingerprint and how to check it on the server.
private struct TrustCard: View {
    var host: DeskHost
    var key: HostKey
    var trust: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("New server key", systemImage: "lock.shield")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.markTop)
            Text("This is the first time this iPhone has connected to \(host.hostname). Check that its key matches before trusting it.")
                .font(.footnote)
                .foregroundStyle(Theme.ink2)
            VStack(alignment: .leading, spacing: 4) {
                Text(key.algorithm).font(.caption).foregroundStyle(Theme.muted)
                MonoBlock(text: key.fingerprint, identifier: "fingerprint")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 4) {
                Text("On the server, this prints the same fingerprint:").font(.caption).foregroundStyle(Theme.muted)
                MonoBlock(text: "ssh-keygen -lf /etc/ssh/ssh_host_\(key.algorithm == "ssh-ed25519" ? "ed25519" : "ecdsa")_key.pub",
                          color: UIColor(hex: 0xc3c2b7), size: 12)
            }
            Button(action: trust) {
                Text("Trust this server").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .card(padding: 16)
    }
}

private struct KeyChangedCard: View {
    var expected: HostKey
    var presented: HostKey

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Server key changed", systemImage: "exclamationmark.shield.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.danger)
            Text("The server presented a different key than the one this iPhone trusts, so nothing was sent. This happens after reinstalling the server, and also when someone is intercepting the connection.")
                .font(.footnote)
                .foregroundStyle(Theme.ink2)
            VStack(alignment: .leading, spacing: 8) {
                MonoBlock(text: "Trusted:   \(expected.fingerprint)", color: UIColor(hex: 0xc3c2b7), size: 12)
                MonoBlock(text: "Presented: \(presented.fingerprint)", color: UIColor(hex: 0xc3c2b7), size: 12)
            }
            Text("If you expected this, forget the pinned key in the desk's Advanced settings and connect again.")
                .font(.caption)
                .foregroundStyle(Theme.muted)
        }
        .card(padding: 16)
    }
}
