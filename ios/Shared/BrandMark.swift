import SwiftUI

/// The Agent Desk mark: a gradient tile with a terminal prompt cut out of it.
struct BrandMark: View {
    static let top = Color(red: 0x9c / 255, green: 0xca / 255, blue: 1)
    static let bottom = Color(red: 0x9b / 255, green: 0x8b / 255, blue: 0xe8 / 255)

    var size: CGFloat = 28

    var body: some View {
        Canvas { context, canvas in
            let scale = canvas.width / 36
            let tile = Path(roundedRect: CGRect(x: 3 * scale, y: 3 * scale, width: 30 * scale, height: 30 * scale),
                            cornerRadius: 8 * scale)
            context.fill(tile, with: .linearGradient(Gradient(colors: [Self.top, Self.bottom]),
                                                     startPoint: CGPoint(x: 4 * scale, y: 4 * scale),
                                                     endPoint: CGPoint(x: 31 * scale, y: 33 * scale)))
            context.blendMode = .destinationOut
            var chevron = Path()
            chevron.move(to: CGPoint(x: 11 * scale, y: 12 * scale))
            chevron.addLine(to: CGPoint(x: 17 * scale, y: 18 * scale))
            chevron.addLine(to: CGPoint(x: 11 * scale, y: 24 * scale))
            context.stroke(chevron, with: .color(.black),
                           style: StrokeStyle(lineWidth: 3.2 * scale, lineCap: .round, lineJoin: .round))
            context.fill(Path(roundedRect: CGRect(x: 20 * scale, y: 21.5 * scale, width: 6 * scale, height: 3 * scale),
                              cornerRadius: scale), with: .color(.black))
        }
        .frame(width: size, height: size)
        .compositingGroup()
        .accessibilityHidden(true)
    }
}
