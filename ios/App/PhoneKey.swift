import CryptoKit
import Foundation
import LocalAuthentication
import AgentDeskKit
import Security

/// This phone's SSH key. On a device it is a P-256 key created inside the Secure Enclave, so
/// it can never leave the phone, and each use needs Face ID or the passcode. The Simulator has
/// no Secure Enclave, so there the key is an ordinary P-256 key in the Keychain.
@MainActor
final class PhoneKey {
    static let shared = PhoneKey()

    enum Kind: String { case secureEnclave = "secure-enclave", keychain }

    private static let service = "AgentDesk.PhoneKey"
    private static let account = "ssh"
    private static let comment = "agent-desk-iphone"

    private(set) var kind = Kind.keychain

    /// The Simulator reports a Secure Enclave but cannot satisfy its user-presence check, having
    /// no passcode; a real iPhone always uses the enclave and never falls back.
    private static var useSecureEnclave: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        SecureEnclave.isAvailable
        #endif
    }
    private var context: LAContext?
    private var cached: SSHKey?

    /// The line to add to ~/.ssh/authorized_keys. Reading it never asks for Face ID.
    func publicKeyLine() throws -> String {
        try key().openSSHPublicKey + " " + Self.comment
    }

    /// The key for signing in. A Face ID approval lasts until the app leaves the foreground,
    /// and unlocking the phone within the last five minutes counts as one.
    func key() throws -> SSHKey {
        if let cached { return cached }
        let context = LAContext()
        context.localizedReason = "Sign in to your Agent Desk servers"
        context.touchIDAuthenticationAllowableReuseDuration = 300
        self.context = context
        let key = try load(context) ?? create(context)
        cached = key
        return key
    }

    /// Forget the approval, so the next sign-in asks again.
    func lock() {
        context?.invalidate()
        context = nil
        cached = nil
    }

    private func load(_ context: LAContext) throws -> SSHKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let found = item as? [String: Any], let data = found[kSecValueData as String] as? Data else {
            throw KeyError.keychain(status)
        }
        if found[kSecAttrDescription as String] as? String == Kind.secureEnclave.rawValue {
            kind = .secureEnclave
            return SSHKey(secureEnclave: try SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: data, authenticationContext: context))
        }
        kind = .keychain
        return SSHKey(p256: try P256.Signing.PrivateKey(rawRepresentation: data))
    }

    private func create(_ context: LAContext) throws -> SSHKey {
        let data: Data
        let key: SSHKey
        if Self.useSecureEnclave {
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                               [.privateKeyUsage, .userPresence], &error) else {
                throw KeyError.accessControl(error?.takeRetainedValue())
            }
            let enclave = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context)
            data = enclave.dataRepresentation
            key = SSHKey(secureEnclave: enclave)
            kind = .secureEnclave
        } else {
            let software = P256.Signing.PrivateKey()
            data = software.rawRepresentation
            key = SSHKey(p256: software)
            kind = .keychain
        }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrDescription as String: kind.rawValue,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeyError.keychain(status) }
        return key
    }

    enum KeyError: LocalizedError {
        case keychain(OSStatus)
        case accessControl(CFError?)

        var errorDescription: String? {
            switch self {
            case .keychain(let status):
                "The Keychain could not store this phone's key (\(SecCopyErrorMessageString(status, nil) as String? ?? "\(status)"))."
            case .accessControl(let error):
                "Could not protect the key with Face ID: \(error.map { String(describing: $0) } ?? "unknown error")."
            }
        }
    }
}
