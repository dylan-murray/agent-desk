import ActivityKit
import SwiftUI
import WidgetKit

@main
struct AgentDeskWidgets: WidgetBundle {
    var body: some Widget {
        DeskLiveActivity()
    }
}

private enum Palette {
    static let surface = Color(red: 0x16 / 255, green: 0x16 / 255, blue: 0x17 / 255)
    static let ink = Color(red: 0xf5 / 255, green: 0xf5 / 255, blue: 0xf4 / 255)
    static let muted = Color(red: 0x8a / 255, green: 0x88 / 255, blue: 0x80 / 255)
    static let amber = Color(red: 0xe7 / 255, green: 0xb6 / 255, blue: 0x68 / 255)
    static let working = Color(red: 0x64 / 255, green: 0xce / 255, blue: 0x98 / 255)
}

struct DeskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeskActivityAttributes.self) { context in
            LockScreenView(state: context.state, hostName: context.attributes.hostName, stale: context.isStale)
                .activityBackgroundTint(Palette.surface)
                .activitySystemActionForegroundColor(Palette.ink)
                .widgetURL(link(context))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Counts(state: context.state).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.attributes.hostName).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Waiting(state: context.state, stale: context.isStale)
                }
            } compactLeading: {
                Image(systemName: context.state.needsYou > 0 ? "hand.raised.fill" : "terminal")
                    .foregroundStyle(context.state.needsYou > 0 ? Palette.amber : Palette.working)
            } compactTrailing: {
                Text("\(context.state.needsYou > 0 ? context.state.needsYou : context.state.working)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(context.state.needsYou > 0 ? Palette.amber : Palette.working)
            } minimal: {
                Image(systemName: context.state.needsYou > 0 ? "hand.raised.fill" : "terminal")
                    .foregroundStyle(context.state.needsYou > 0 ? Palette.amber : Palette.working)
            }
            .widgetURL(link(context))
        }
    }

    private func link(_ context: ActivityViewContext<DeskActivityAttributes>) -> URL {
        if let id = context.state.waitingID { return DeskLink.session(host: context.attributes.hostID, terminal: id) }
        return DeskLink.host(context.attributes.hostID)
    }
}

private struct LockScreenView: View {
    var state: DeskActivityAttributes.ContentState
    var hostName: String
    var stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                BrandMark(size: 22)
                Text(hostName).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Spacer()
                Counts(state: state)
            }
            Waiting(state: state, stale: stale)
        }
        .padding(16)
    }
}

private struct Counts: View {
    var state: DeskActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 10) {
            if state.needsYou > 0 {
                Label("\(state.needsYou)", systemImage: "hand.raised.fill").foregroundStyle(Palette.amber)
            }
            Label("\(state.working)", systemImage: "waveform").foregroundStyle(Palette.working)
        }
        .font(.caption.weight(.semibold).monospacedDigit())
        .labelStyle(.titleAndIcon)
    }
}

private struct Waiting: View {
    var state: DeskActivityAttributes.ContentState
    var stale: Bool

    var body: some View {
        Group {
            if let name = state.waitingName {
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(name) needs you").font(.caption.weight(.semibold)).foregroundStyle(Palette.amber)
                    if let question = state.waitingQuestion {
                        Text(question).font(.footnote).foregroundStyle(Palette.ink).lineLimit(2)
                    }
                }
            } else {
                Text(state.working > 0 ? "\(state.working) of \(state.running) sessions producing output"
                                       : "\(state.running) sessions running, all quiet")
                    .font(.footnote)
                    .foregroundStyle(Palette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottomTrailing) {
            if stale || !state.connected {
                Text("As of \(state.updated, style: .time)").font(.caption2).foregroundStyle(Palette.muted)
            }
        }
    }
}
