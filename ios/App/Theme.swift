import AgentDeskKit
import SwiftUI

/// Agent Desk's dark palette, from the web app's palette.css and terminals.css.
enum Theme {
    static let page = Color(hex: 0x0c0c0d)
    static let surface = Color(hex: 0x161617)
    static let raised = Color(hex: 0x1d1d1f)
    static let ink = Color(hex: 0xf5f5f4)
    static let ink2 = Color(hex: 0xc3c2b7)
    static let muted = Color(hex: 0x8a8880)
    static let border = Color.white.opacity(0.09)
    static let borderStrong = Color.white.opacity(0.16)
    static let accent = Color(hex: 0x3987e5)
    static let danger = Color(hex: 0xe66767)
    static let amber = Color(hex: 0xe7b668)
    static let working = Color(hex: 0x64ce98)
    static let quiet = Color(hex: 0x8b95a5)
    static let completed = Color(hex: 0x7197ba)
    static let unknown = Color(hex: 0x666a73)
    static let peach = Color(hex: 0xd9a34c)
    static let pink = Color(hex: 0xd55181)
    static let lavender = Color(hex: 0x9085e9)
    static let markTop = Color(hex: 0x9ccaff)
    static let markBottom = Color(hex: 0x9b8be8)

    static let mono = Font.system(.footnote, design: .monospaced)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}

/// How a session's status reads and looks, matching the desk's sidebar.
struct StatusStyle {
    var label: String
    var color: Color
    var pulses = false

    init(_ session: Session) {
        if session.isRunning {
            switch session.status {
            case "needs_input": self.init(label: "Needs you", color: Theme.amber)
            case "output": self.init(label: "Output active", color: Theme.working, pulses: true)
            case "quiet": self.init(label: "Quiet", color: Theme.quiet)
            default: self.init(label: "Unknown", color: Theme.unknown)
            }
        } else if session.exitCode == 0 {
            self.init(label: "Completed", color: Theme.completed)
        } else {
            self.init(label: "Exited \(session.exitCode.map(String.init) ?? "")", color: Theme.danger)
        }
    }

    init(label: String, color: Color, pulses: Bool = false) {
        self.label = label
        self.color = color
        self.pulses = pulses
    }
}

/// The desk's status dot: a soft pulse while output is arriving.
struct StatusDot: View {
    var style: StatusStyle
    var size: CGFloat = 7
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(style.color)
            .frame(width: size, height: size)
            .opacity(style.pulses && dim ? 0.35 : 1)
            .onAppear {
                guard style.pulses else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

/// A short uppercase section label, like the desk's sidebar headings.
struct SectionLabel: View {
    var text: String
    var count: Int?

    var body: some View {
        HStack {
            Text(text.uppercased())
            Spacer()
            if let count { Text("\(count)").monospacedDigit() }
        }
        .font(.caption2.weight(.medium))
        .tracking(1.2)
        .foregroundStyle(Theme.muted)
    }
}

extension View {
    /// A raised card on the page background.
    func card(padding: CGFloat = 14) -> some View {
        self.padding(padding)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(Theme.border))
    }
}

/// "12s ago", "4m ago", from a desk timestamp in seconds since 1970.
func relativeAge(_ timestamp: Double?, now: Date = .now) -> String? {
    guard let timestamp else { return nil }
    let seconds = max(0, Int(now.timeIntervalSince1970 - timestamp))
    switch seconds {
    case ..<5: return "now"
    case ..<60: return "\(seconds)s ago"
    case ..<3600: return "\(seconds / 60)m ago"
    case ..<86400: return "\(seconds / 3600)h ago"
    default: return "\(seconds / 86400)d ago"
    }
}

/// The harness name as a person would say it.
func harnessName(_ harness: String?) -> String? {
    switch harness {
    case "claude": "Claude"
    case "codex": "Codex"
    case "grok": "Grok"
    case "cortex": "Cortex"
    case "shell", "zsh", "bash", "fish", "sh": "Shell"
    case let other?: other.capitalized
    case nil: nil
    }
}

func harnessColor(_ harness: String?) -> Color {
    switch harness {
    case "claude": Theme.peach
    case "grok": Theme.pink
    case "codex": Theme.accent
    case "cortex": Theme.lavender
    default: Theme.ink2
    }
}

/// Monospaced text that wraps anywhere and never hyphenates: SwiftUI's Text inserts hyphens
/// when it breaks a long token, which would corrupt a key someone copies by eye.
struct MonoBlock: UIViewRepresentable {
    var text: String
    var color: UIColor = UIColor(hex: 0xf5f5f4)
    var size: CGFloat = 13
    var identifier: String?

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.textContainer.lineBreakMode = .byCharWrapping
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byCharWrapping
        style.hyphenationFactor = 0
        style.lineSpacing = 3
        view.attributedText = NSAttributedString(string: text, attributes: [
            .font: UIFont.monospacedSystemFont(ofSize: size, weight: .regular),
            .foregroundColor: color,
            .paragraphStyle: style,
        ])
        view.accessibilityIdentifier = identifier
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fitted.height))
    }
}
