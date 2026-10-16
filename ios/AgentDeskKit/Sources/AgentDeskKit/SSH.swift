import Crypto
import Foundation
import NIOCore
import NIOPosix
import NIOSSH

/// A P-256 key this client signs in with: kept in the Secure Enclave on a phone.
public struct SSHKey: Sendable {
    let key: NIOSSHPrivateKey

    public init(p256 key: P256.Signing.PrivateKey) {
        self.key = NIOSSHPrivateKey(p256Key: key)
    }

    #if canImport(Darwin)
    public init(secureEnclave key: SecureEnclave.P256.Signing.PrivateKey) {
        self.key = NIOSSHPrivateKey(secureEnclaveP256Key: key)
    }
    #endif

    /// "ecdsa-sha2-nistp256 AAAA…", for authorized_keys.
    public var openSSHPublicKey: String { String(openSSHPublicKey: key.publicKey) }
}

/// A server's SSH host key, as OpenSSH writes it in known_hosts.
public struct HostKey: Codable, Hashable, Sendable {
    /// "ssh-ed25519 AAAA…"
    public let openSSH: String

    public init(openSSH: String) {
        self.openSSH = openSSH.split(separator: " ").prefix(2).joined(separator: " ")
    }

    init(_ key: NIOSSHPublicKey) {
        self.init(openSSH: String(openSSHPublicKey: key))
    }

    public var algorithm: String { String(openSSH.split(separator: " ").first ?? "") }

    /// The fingerprint `ssh-keygen -l` prints, so it can be compared on the server.
    public var fingerprint: String {
        let parts = openSSH.split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return "invalid key" }
        let digest = Data(SHA256.hash(data: blob)).base64EncodedString()
        return "SHA256:" + digest.trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}

public enum SSHError: Error, LocalizedError, Equatable {
    /// First connection to this server: the person must confirm its key before anything is sent.
    case unknownHostKey(HostKey)
    /// The server's key is not the one pinned for it. This is what an interception looks like.
    case hostKeyChanged(expected: HostKey, presented: HostKey)
    case authenticationFailed
    case unreachable(String)
    case commandFailed(status: Int, stderr: String)
    case disconnected

    public var errorDescription: String? {
        switch self {
        case .unknownHostKey(let key):
            return "This server's \(key.algorithm) key is new to this phone: \(key.fingerprint)"
        case .hostKeyChanged(_, let presented):
            return "This server's key changed to \(presented.fingerprint). The connection was stopped in case someone is intercepting it."
        case .authenticationFailed:
            return "The server did not accept this phone's key. Add the phone's public key to ~/.ssh/authorized_keys on the server."
        case .unreachable(let reason):
            return "Could not reach the server: \(reason)"
        case .commandFailed(let status, let stderr):
            let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty ? "The command on the server failed with status \(status)." : detail
        case .disconnected:
            return "The SSH connection closed."
        }
    }
}

/// What a command printed and how it exited.
public struct CommandResult: Sendable {
    public var stdout: Data
    public var stderr: Data
    public var status: Int
}

/// An authenticated SSH connection that runs commands, each on its own session channel.
public final class SSHConnection: Sendable {
    private let channel: Channel

    private init(channel: Channel) {
        self.channel = channel
    }

    /// Connects, checks the host key against the pinned one, and authenticates with `key`.
    public static func connect(host: String, port: Int, username: String, key: SSHKey, pinned: HostKey?,
                               timeout: TimeAmount = .seconds(15)) async throws -> SSHConnection {
        let group = MultiThreadedEventLoopGroup.singleton
        let ready = group.next().makePromise(of: Void.self)
        let bootstrap = ClientBootstrap(group: group)
            .connectTimeout(timeout)
            .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_NODELAY), value: 1)
            .channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    let ssh = NIOSSHHandler(
                        role: .client(.init(userAuthDelegate: PublicKeyOffer(username: username, key: key.key),
                                            serverAuthDelegate: PinnedHostKey(pinned: pinned))),
                        allocator: channel.allocator, inboundChildChannelInitializer: nil)
                    try channel.pipeline.syncOperations.addHandlers([ssh, ReadyHandler(ready: ready)])
                }
            }
        let channel: Channel
        do {
            channel = try await bootstrap.connect(host: host, port: port).get()
        } catch {
            ready.fail(error)
            throw SSHError.unreachable(Self.describe(error))
        }
        let deadline = channel.eventLoop.scheduleTask(in: timeout) { ready.fail(SSHError.unreachable("timed out")) }
        do {
            try await ready.futureResult.get()
            deadline.cancel()
        } catch {
            deadline.cancel()
            try? await channel.close()
            throw error
        }
        return SSHConnection(channel: channel)
    }

    private static func describe(_ error: Error) -> String {
        if let error = error as? IOError { return error.description }
        if let error = error as? ChannelError, case .connectTimeout = error { return "timed out" }
        return String(describing: error)
    }

    /// Runs `command`, sends `input` and end-of-file to it, and collects its output.
    public func run(_ command: String, input: Data? = nil) async throws -> CommandResult {
        var stdout = Data(), stderr = Data()
        var status = -1
        for try await event in exec(command, input: input) {
            switch event {
            case .stdout(let data): stdout += data
            case .stderr(let data): stderr += data
            case .exit(let code): status = code
            }
        }
        return CommandResult(stdout: stdout, stderr: stderr, status: status)
    }

    public enum ExecEvent: Sendable {
        case stdout(Data)
        case stderr(Data)
        case exit(Int)
    }

    /// Runs `command` and streams what it prints. Ending iteration closes the channel, which
    /// hangs up on the command.
    public func exec(_ command: String, input: Data? = nil) -> AsyncThrowingStream<ExecEvent, Error> {
        AsyncThrowingStream { continuation in
            let opened = channel.eventLoop.makePromise(of: Channel.self)
            channel.eventLoop.execute { [channel] in
                do {
                    let ssh = try channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
                    ssh.createChannel(opened, channelType: .session) { child, type in
                        guard type == .session else { return child.eventLoop.makeFailedFuture(SSHError.disconnected) }
                        return child.eventLoop.makeCompletedFuture {
                            try child.pipeline.syncOperations.addHandler(
                                ExecHandler(command: command, input: input, continuation: continuation))
                        }
                    }
                } catch {
                    opened.fail(error)
                }
            }
            opened.futureResult.whenFailure { continuation.finish(throwing: $0 as? SSHError ?? SSHError.disconnected) }
            continuation.onTermination = { _ in
                opened.futureResult.whenSuccess { $0.close(promise: nil) }
            }
        }
    }

    public var isActive: Bool { channel.isActive }

    /// The server's address, for reaching it over UDP for Mosh.
    public var remoteAddress: String? { channel.remoteAddress?.ipAddress }

    public func close() async {
        try? await channel.close()
    }
}

/// Offers one key and gives up if the server declines it: there is nothing else to try.
private final class PublicKeyOffer: NIOSSHClientUserAuthenticationDelegate, @unchecked Sendable {
    private let username: String
    private let key: NIOSSHPrivateKey
    private var offered = false

    init(username: String, key: NIOSSHPrivateKey) {
        self.username = username
        self.key = key
    }

    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods,
                                nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard !offered, availableMethods.contains(.publicKey) else {
            nextChallengePromise.fail(SSHError.authenticationFailed)
            return
        }
        offered = true
        nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: username, serviceName: "",
                                                                   offer: .privateKey(.init(privateKey: key))))
    }
}

/// Trust on first use: no pinned key means the person has not seen this server yet.
private final class PinnedHostKey: NIOSSHClientServerAuthenticationDelegate, Sendable {
    private let pinned: HostKey?

    init(pinned: HostKey?) { self.pinned = pinned }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let presented = HostKey(hostKey)
        switch pinned {
        case nil: validationCompletePromise.fail(SSHError.unknownHostKey(presented))
        case presented?: validationCompletePromise.succeed(())
        case let expected?: validationCompletePromise.fail(SSHError.hostKeyChanged(expected: expected, presented: presented))
        }
    }
}

/// Completes `ready` once the server has accepted the key, or fails it with the reason it did not.
private final class ReadyHandler: ChannelInboundHandler, Sendable {
    typealias InboundIn = Any
    private let ready: EventLoopPromise<Void>

    init(ready: EventLoopPromise<Void>) { self.ready = ready }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is UserAuthSuccessEvent { ready.succeed(()) }
        context.fireUserInboundEventTriggered(event)
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        ready.fail(error is SSHError ? error : Self.translate(error))
        context.close(promise: nil)
    }

    func channelInactive(context: ChannelHandlerContext) {
        ready.fail(SSHError.disconnected)
        context.fireChannelInactive()
    }

    private static func translate(_ error: Error) -> Error {
        if let ssh = error as? NIOSSHError, ssh.type == .keyExchangeNegotiationFailure {
            return SSHError.unreachable("the server offers no key exchange, cipher or host key type this app supports "
                + "(it needs an Ed25519 or ECDSA host key and AES-GCM, which OpenSSH enables by default)")
        }
        return SSHError.unreachable(String(describing: error))
    }
}

/// One command on one session channel.
private final class ExecHandler: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias OutboundIn = Never
    typealias OutboundOut = SSHChannelData

    private let command: String
    private let input: Data?
    private let continuation: AsyncThrowingStream<SSHConnection.ExecEvent, Error>.Continuation

    init(command: String, input: Data?, continuation: AsyncThrowingStream<SSHConnection.ExecEvent, Error>.Continuation) {
        self.command = command
        self.input = input
        self.continuation = continuation
    }

    func handlerAdded(context: ChannelHandlerContext) {
        // Keep reading after the command's stdin is closed.
        context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { [continuation] in
            continuation.finish(throwing: $0)
        }
    }

    func channelActive(context: ChannelHandlerContext) {
        let request = SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true)
        context.triggerUserOutboundEvent(request, promise: nil)
        if let input, !input.isEmpty {
            let buffer = context.channel.allocator.buffer(bytes: input)
            context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(buffer))), promise: nil)
        }
        context.flush()
        context.close(mode: .output, promise: nil)
        context.fireChannelActive()
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard case .byteBuffer(var buffer) = message.data, let bytes = buffer.readData(length: buffer.readableBytes) else { return }
        continuation.yield(message.type == .stdErr ? .stderr(bytes) : .stdout(bytes))
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        switch event {
        case let status as SSHChannelRequestEvent.ExitStatus:
            continuation.yield(.exit(status.exitStatus))
        case is ChannelFailureEvent:
            continuation.finish(throwing: SSHError.commandFailed(status: -1, stderr: "The server refused to run the command."))
            context.close(promise: nil)
        default:
            context.fireUserInboundEventTriggered(event)
        }
    }

    func channelInactive(context: ChannelHandlerContext) {
        continuation.finish()
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        continuation.finish(throwing: error)
        context.close(promise: nil)
    }
}
