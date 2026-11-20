import Foundation
import Testing
@testable import AgentDeskKit

private func result(_ stdout: String, stderr: String = "", status: Int = 0) -> CommandResult {
    CommandResult(stdout: Data(stdout.utf8), stderr: Data(stderr.utf8), status: status)
}

@Test func commandsRunThroughTheLoginShellWithEveryArgumentQuoted() {
    var host = DeskHost(name: "Mac", hostname: "mac.local", username: "me")
    host.deskPort = 4377
    host.agentDeskCommand = "python3 -m agent_desk"
    #expect(Remote.mobile(host, "info") == #"exec "$SHELL" -lc 'python3 -m agent_desk mobile --port 4377 info'"#)
    #expect(Remote.attach(host, terminal: "remote:it's") == #"exec "$SHELL" -lc 'LANG=en_US.UTF-8 MOSH_SERVER_NETWORK_TMOUT=21600 mosh-server new -s -c 256 -l LANG=en_US.UTF-8 -- python3 -m agent_desk attach --port 4377 '\''remote:it'\''\'\'''\''s'\'''"#)
    // What the login shell then runs, once the outer quoting is undone.
    #expect(Remote.quote("a'b") == #"'a'\''b'"#)
}

@Test func answersAreFoundAfterLoginBanners() throws {
    let stdout = """
        Welcome to the build box
        {"type":"info","protocol":1,"port":4310,"desks":[{"id":"main","name":"Main"}],"launch_choices":[{"key":"claude","label":"Claude","harness":"claude"}],"projects":[{"name":"app","path":"/src/app"}]}

        """
    let info = try Remote.decodeAnswer(result(stdout), as: DeskInfo.self, expecting: "info")
    #expect(info.desks == [DeskRef(id: "main", name: "Main")])
    #expect(info.launchChoices.map(\.key) == ["claude"])
    #expect(info.projects == [Project(name: "app", path: "/src/app")])
}

@Test func deskErrorsAndVersionMismatchesAreExplained() {
    #expect(throws: DeskError("Agent Desk is not running on port 4310. Start it with: agent-desk --port 4310")) {
        try Remote.decodeAnswer(result(#"{"type": "error", "protocol": 1, "message": "Agent Desk is not running on port 4310. Start it with: agent-desk --port 4310"}"#, status: 1),
                                as: DeskInfo.self, expecting: "info")
    }
    #expect(throws: DeskError("The server runs a newer Agent Desk than this app understands. Update the app.")) {
        try Remote.decodeAnswer(result(#"{"type":"info","protocol":2}"#), as: DeskInfo.self, expecting: "info")
    }
    #expect(throws: DeskError("The server's Agent Desk is too old for this app. Update it there.")) {
        try Remote.decodeAnswer(result("", stderr: "agent-desk: error: unrecognized arguments: mobile", status: 2),
                                as: DeskInfo.self, expecting: "info")
    }
    let missing = #expect(throws: DeskError.self) {
        try Remote.decodeAnswer(result("", stderr: "zsh:1: command not found: agent-desk", status: 127), as: DeskInfo.self, expecting: "info")
    }
    #expect(missing?.message.hasPrefix("Agent Desk was not found by the login shell on the server.") == true)
}

@Test func snapshotsDecodeTheWatchOutput() throws {
    // A line `agent-desk mobile watch` printed for a desk with one session at an approval prompt.
    let line = #"{"type": "snapshot", "protocol": 1, "desks": [{"id": "main", "name": "Main"}], "sessions": [{"id": "terminal-1", "name": "Claude", "desk": "main", "harness": "claude", "launch_profile": "claude", "cwd": "/src/app", "project": "app", "status": "needs_input", "question": "Do you want to proceed?", "exit_code": null, "last_output": 1791870520.28, "active_since": 1791870520.25, "parent_id": null, "remote": false, "controller": false}], "ready": true}"#
    let snapshot = try #require(try Remote.decodeLine(line[...], as: Snapshot.self, expecting: "snapshot"))
    #expect(snapshot.ready)
    let session = try #require(snapshot.sessions.first)
    #expect(session.needsInput && session.isRunning && !session.isWorking)
    #expect(session.question == "Do you want to proceed?")
    #expect(try Remote.decodeLine(#"{"type": "heartbeat", "protocol": 1}"#[...], as: Snapshot.self, expecting: "snapshot") == nil)
    #expect(try Remote.decodeLine("Last login: today"[...], as: Snapshot.self, expecting: "snapshot") == nil)
}

@Test func moshConnectIsReadFromServerOutput() throws {
    let ticket = try Remote.parseMoshConnect(result("\r\nMOSH CONNECT 60004 4NeCCgvZFe2RnPgrcU1PQw\r\n",
                                                    stderr: "\nmosh-server (mosh 1.4.0)\n[mosh-server detached, pid = 4242]\n"))
    #expect(ticket.port == 60004 && ticket.pid == 4242)
    let missing = #expect(throws: DeskError.self) {
        try Remote.parseMoshConnect(result("", stderr: "zsh:1: command not found: mosh-server", status: 127))
    }
    #expect(missing?.message.hasPrefix("mosh-server was not found by the login shell on the server.") == true)
}
