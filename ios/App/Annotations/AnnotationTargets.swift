import SwiftUI
import UIKit

/// Developer annotations: settings shared by the views that take part.
enum DeveloperSettings {
    static let annotationsKey = "developerAnnotations"
}

/// The views a pin can land on, each with its name, what it shows, and where it is written, so
/// a note can say "SessionRow in Views/SessionsView.swift:142" rather than only a point.
@MainActor
final class AnnotationTargets {
    static let shared = AnnotationTargets()

    struct Target: Equatable {
        var id: String
        var detail: String?
        var source: String
        var frame: CGRect
        /// 0 for a screen, 1 for a sheet over it, and so on: a sheet's views sit above the screen beneath.
        var layer: Int
    }

    private var targets: [UUID: Target] = [:]
    /// The app's own window; the overlay draws and reads the layers of this one.
    weak var appWindow: UIWindow?

    func update(_ key: UUID, _ target: Target) {
        targets[key] = target
    }

    func remove(_ key: UUID) {
        targets[key] = nil
    }

    /// The innermost tagged view under a point, on the topmost layer showing anything there. A
    /// point on a sheet only finds the sheet's views, never the screen behind it.
    func target(at point: CGPoint) -> Target? {
        let (depth, sheet) = presentation
        let lowest = sheet.map { $0.contains(point) } == true ? depth : 0
        let hits = targets.values.filter { $0.frame.contains(point) && (lowest...depth).contains($0.layer) }
        guard let top = hits.map(\.layer).max() else { return nil }
        return hits.filter { $0.layer == top }.min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    /// How many sheets are presented over the app right now, and where the topmost one is.
    var presentation: (depth: Int, frame: CGRect?) {
        var controller = appWindow?.rootViewController
        var depth = 0
        while let next = controller?.presentedViewController, !next.isBeingDismissed {
            depth += 1
            controller = next
        }
        guard depth > 0, let view = controller?.view, let window = appWindow else { return (0, nil) }
        return (depth, view.convert(view.bounds, to: window))
    }
}

private struct AnnotationLayerKey: EnvironmentKey {
    static let defaultValue = 0
}

extension EnvironmentValues {
    var annotationLayer: Int {
        get { self[AnnotationLayerKey.self] }
        set { self[AnnotationLayerKey.self] = newValue }
    }
}

private struct AnnotationTargetModifier: ViewModifier {
    var id: String
    var detail: String?
    var source: String
    @AppStorage(DeveloperSettings.annotationsKey) private var enabled = false
    @Environment(\.annotationLayer) private var layer
    @State private var key = UUID()

    func body(content: Content) -> some View {
        if enabled {
            content
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frame in
                    AnnotationTargets.shared.update(key, .init(id: id, detail: detail, source: source, frame: frame, layer: layer))
                }
                .onDisappear { AnnotationTargets.shared.remove(key) }
        } else {
            content
        }
    }
}

private struct AnnotationLayerModifier: ViewModifier {
    @Environment(\.annotationLayer) private var layer

    func body(content: Content) -> some View {
        content.environment(\.annotationLayer, layer + 1)
    }
}

extension View {
    /// Marks a sheet's content as sitting above the screen that presented it.
    func annotationLayer() -> some View {
        modifier(AnnotationLayerModifier())
    }

    /// Names this view for developer annotations. The file and line default to the call site; the
    /// file is named without its module, as file names are unique within the app.
    func annotationTarget(_ id: String, _ detail: String? = nil, file: String = #fileID, line: Int = #line) -> some View {
        modifier(AnnotationTargetModifier(id: id, detail: detail, source: "\(file.split(separator: "/").last ?? ""):\(line)"))
    }
}
