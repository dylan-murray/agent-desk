import SwiftUI

/// The public half of this phone's key, ready to paste into a server's authorized_keys.
struct PhoneKeyView: View {
    @State private var line: String?
    @State private var error: String?
    @State private var copied = false
    @State private var kind: PhoneKey.Kind?

    private var command: String? {
        line.map { "echo '\($0)' >> ~/.ssh/authorized_keys" }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let kind {
                    Text(kind == .secureEnclave
                         ? "This key was made inside this iPhone's Secure Enclave. It can't be copied off the phone, and signing in with it takes Face ID."
                         : "This key is kept in this device's Keychain. (The Simulator has no Secure Enclave; on an iPhone the key lives there.)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.ink2)
                }

                if let line {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Public key")
                        MonoBlock(text: line, identifier: "phone-key")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .card()
                        HStack(spacing: 10) {
                            Button {
                                UIPasteboard.general.string = line
                                copied = true
                            } label: {
                                Label(copied ? "Copied" : "Copy key", systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            ShareLink(item: line) {
                                Label("Share", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                    }

                    if let command {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionLabel(text: "Or run this on the server")
                            MonoBlock(text: command, color: UIColor(hex: 0xc3c2b7))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .card()
                        }
                    }
                } else if let error {
                    Text(error).foregroundStyle(Theme.danger).card()
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(Theme.page)
        .navigationTitle("This iPhone's key")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                line = try PhoneKey.shared.publicKeyLine()
                kind = PhoneKey.shared.kind
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
