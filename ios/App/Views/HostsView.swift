import AgentDeskKit
import SwiftUI

/// The desks this phone can reach, or a short setup guide before there are any.
struct HostsView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: DeskHost?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 10) {
                    BrandMark(size: 30)
                    Text("Agent Desk").font(.title2.weight(.semibold)).tracking(-0.6)
                }
                .padding(.top, 6)
                .annotationTarget("AppTitle")

                if model.hosts.isEmpty {
                    WelcomeCard { editing = DeskHost(name: "", hostname: "", username: "") }
                        .annotationTarget("WelcomeCard")
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Desks", count: model.hosts.count)
                        ForEach(model.hosts) { host in
                            NavigationLink(value: AppModel.Route.host(host.id)) {
                                HostRow(host: host, connection: model.connection(host.id))
                            }
                            .buttonStyle(.plain)
                            .annotationTarget("HostRow", host.name)
                            .contextMenu {
                                Button("Edit", systemImage: "pencil") { editing = host }
                                Button("Remove", systemImage: "trash", role: .destructive) { model.delete(host.id) }
                            }
                        }
                        Button {
                            editing = DeskHost(name: "", hostname: "", username: "")
                        } label: {
                            Label("Add a desk", systemImage: "plus")
                                .font(.subheadline.weight(.medium))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .card()
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.ink2)
                    }
                }

                NavigationLink(value: AppModel.Route.phoneKey) {
                    HStack(spacing: 12) {
                        Image(systemName: "key.horizontal")
                            .foregroundStyle(Theme.lavender)
                            .frame(width: 30, height: 30)
                            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("This iPhone's key").font(.subheadline.weight(.medium))
                            Text("Add it to authorized_keys on each server").font(.caption).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    }
                    .card()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("phone-key-link")
                .annotationTarget("PhoneKeyLink")

                NavigationLink(value: AppModel.Route.developer) {
                    HStack(spacing: 12) {
                        Image(systemName: "hammer")
                            .foregroundStyle(Theme.ink2)
                            .frame(width: 30, height: 30)
                            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 8))
                        Text("Developer").font(.subheadline.weight(.medium))
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    }
                    .card()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("developer-link")
                .annotationTarget("DeveloperLink")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.bottom, 30)
        }
        .background(Theme.page)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $editing) { host in
            HostEditor(host: host, isNew: model.host(host.id) == nil) { saved in
                model.save(saved)
                if model.hosts.count == 1 { model.path = [.host(saved.id)] }
            }
            .annotationLayer()
        }
    }
}

private struct HostRow: View {
    var host: DeskHost
    var connection: DeskConnection?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(Theme.markTop)
                .frame(width: 34, height: 34)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 3) {
                Text(host.name).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                Text("\(host.username)@\(host.hostname)").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            if let connection, connection.state == .connected {
                let waiting = connection.sessions.filter(\.needsInput).count
                let running = connection.sessions.filter(\.isRunning).count
                if waiting > 0 {
                    Label("\(waiting)", systemImage: "hand.raised.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.amber)
                } else {
                    Text("\(running) running").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
        }
        .card()
    }
}

/// What it takes to reach a desk from the phone, in the order it has to happen.
private struct WelcomeCard: View {
    var add: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your agents, from your phone").font(.title3.weight(.semibold)).tracking(-0.4)
                Text("Agent Desk keeps running on your Mac or server. This app reaches it over SSH and Mosh, so terminals stay live as you move between Wi-Fi and cellular.")
                    .font(.subheadline).foregroundStyle(Theme.ink2)
            }
            VStack(alignment: .leading, spacing: 14) {
                SetupStep(number: 1, title: "Make the machine reachable",
                          detail: "Turn on Remote Login (System Settings → General → Sharing) on a Mac. Tailscale makes it reachable away from home.")
                SetupStep(number: 2, title: "Install Mosh there", detail: "brew install mosh", code: true)
                SetupStep(number: 3, title: "Trust this iPhone",
                          detail: "Add this iPhone's key to ~/.ssh/authorized_keys. Find it below.")
            }
            Button(action: add) {
                Text("Add a desk").font(.body.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
        }
        .card(padding: 18)
    }
}

private struct SetupStep: View {
    var number: Int
    var title: String
    var detail: String
    var code = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.markTop)
                .frame(width: 22, height: 22)
                .background(Theme.raised, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail)
                    .font(code ? Theme.mono : .footnote)
                    .foregroundStyle(code ? Theme.ink : Theme.muted)
                    .textSelection(.enabled)
            }
        }
    }
}
