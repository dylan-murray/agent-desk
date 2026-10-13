import Crypto
import Foundation
import NIOSSH
import Testing
@testable import AgentDeskKit

@Suite(.serialized)
struct SSHTests {
    let server: TestSSHServer

    init() throws { server = try TestSSHServer() }

    @Test func aNewServerIsRefusedUntilItsKeyIsPinnedThenCommandsRun() async throws {
        let unknown = await #expect(throws: SSHError.self) { try await server.connect(pinned: nil) }
        guard case .unknownHostKey(let presented)? = unknown else { Issue.record("expected an unknown host key"); return }
        #expect(presented == server.hostKey)
        // The fingerprint the app shows is the one `ssh-keygen -l` prints on the server.
        #expect(presented.fingerprint == (try server.opensshFingerprint()))

        let ssh = try await server.connect(pinned: presented)
        let answer = try await ssh.run("echo $((6*7)); echo oops >&2; exit 3")
        #expect(String(decoding: answer.stdout, as: UTF8.self) == "42\n")
        #expect(String(decoding: answer.stderr, as: UTF8.self) == "oops\n")
        #expect(answer.status == 3)
        // Input reaches the command, followed by end-of-file.
        let echoed = try await ssh.run("cat; echo done", input: Data("from the phone\n".utf8))
        #expect(String(decoding: echoed.stdout, as: UTF8.self) == "from the phone\ndone\n")
        // Commands share the connection.
        async let first = ssh.run("echo one")
        async let second = ssh.run("echo two")
        #expect(try await [first.stdout, second.stdout].map { String(decoding: $0, as: UTF8.self) } == ["one\n", "two\n"])
        await ssh.close()
    }

    @Test func aChangedHostKeyStopsTheConnection() async throws {
        let impostor = HostKey(openSSH: String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key: .init()).publicKey))
        let error = await #expect(throws: SSHError.self) { try await server.connect(pinned: impostor) }
        #expect(error == .hostKeyChanged(expected: impostor, presented: server.hostKey))
    }

    @Test func aKeyTheServerDoesNotTrustIsExplained() async throws {
        let error = await #expect(throws: SSHError.self) {
            try await server.connect(pinned: server.hostKey, key: NIOSSHPrivateKey(p256Key: .init()))
        }
        #expect(error == .authenticationFailed)
    }

    @Test func endingAStreamHangsUpOnTheCommand() async throws {
        let ssh = try await server.connect(pinned: server.hostKey)
        let marker = "tick-\(UUID().uuidString.prefix(8))"
        var ticks = 0
        for try await event in ssh.exec("exec sh -c 'while :; do echo \(marker); sleep 0.1; done'") {
            if case .stdout = event { ticks += 1 }
            if ticks == 3 { break }
        }
        let gone = await eventually {
            (try? TestSSHServer.run("/usr/bin/pgrep", "-f", marker))?.isEmpty ?? false
        }
        #expect(gone)
        await ssh.close()
    }

    @Test func anUnreachableServerFailsQuickly() async throws {
        let error = await #expect(throws: SSHError.self) {
            try await SSHConnection.connect(host: "127.0.0.1", port: 1, username: "nobody", key: server.key, pinned: nil)
        }
        guard case .unreachable? = error else { Issue.record("expected unreachable, got \(String(describing: error))"); return }
    }
}
