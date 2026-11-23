import Foundation
import Network

/// How a Mosh session is doing, as the person holding the phone would care.
public enum MoshStatus: Equatable, Sendable {
    /// Waiting for the server's first reply.
    case connecting
    case connected
    /// Nothing heard from the server for a while; input is kept and sent when it returns.
    case unreachable(since: Date)
    case closed(MoshClosedReason)
}

public enum MoshClosedReason: Equatable, Sendable {
    /// The program the server was running exited, so the server shut down.
    case serverExited
    /// This client ended the session.
    case clientClosed
}

/// A client for one `mosh-server` session: the Mosh state-synchronization protocol over UDP.
///
/// The client keeps only the newest server state. Each screen update the server sends is
/// terminal output that turns its previous screen into the new one, so updates are applied
/// to a terminal emulator in order, and an update made against a state this client does not
/// hold is dropped until the server resends it against the acknowledged state.
///
/// Keystrokes and resizes are always sent as a diff from the last state the server
/// acknowledged, so a lost datagram never loses input. Local echo prediction is not done.
public final class MoshClient: @unchecked Sendable {
    // Timing, in milliseconds, from Mosh's transport.
    static let sendIntervalMin: UInt64 = 20
    static let sendIntervalMax: UInt64 = 250
    static let ackInterval: UInt64 = 3000
    static let ackDelay: UInt64 = 100
    static let portHopInterval: UInt64 = 10_000
    /// The server acknowledges at least every three seconds; two missed beats is a lost link.
    static let unreachableAfter: UInt64 = 6500
    static let shutdownTries = 16
    /// Fragment payload size that keeps datagrams under a 1280-byte path MTU, Tailscale's included.
    static let fragmentSize = 1000

    private let queue = DispatchQueue(label: "MoshClient")
    private let callbackQueue: DispatchQueue
    private let host: NWEndpoint.Host
    private let port: NWEndpoint.Port
    private let cipher: PacketCipher
    private let onEvents: @Sendable ([HostEvent]) -> Void
    private let onStatus: @Sendable (MoshStatus) -> Void

    /// Tests drop datagrams with this to exercise loss recovery: it returns true to drop one.
    var dropDatagram: (@Sendable (_ outgoing: Bool) -> Bool)?

    private var connection: NWConnection?
    private var timer: DispatchSourceTimer?
    private var status = MoshStatus.connecting
    private var started: UInt64 = 0

    // Sending: user events not yet acknowledged, and the states sent that contain them.
    private var nextSeq: UInt64 = 0
    private var events: [UserEvent] = []
    private var eventsBase = 0
    /// The first entry is the state the server acknowledged; `end` counts the events it holds.
    private var sent: [(num: UInt64, end: Int)] = [(0, 0)]
    private var lastSentAt: UInt64 = 0
    private var nextAckAt: UInt64 = 0
    private var fragmentID: UInt64 = 0
    private var lastHop: UInt64 = 0
    private var shuttingDown = false
    private var shutdownSends = 0
    private var serverExitAcks = 0

    // Receiving.
    private var remoteNum: UInt64 = 0
    private var assembly = FragmentAssembly()
    private var expectedSeq: UInt64 = 0
    private var savedTimestamp: UInt16?
    private var savedTimestampAt: UInt64 = 0
    private var srtt: Double = 1000
    private var rttvar: Double = 500
    private var hasRTT = false
    private var lastHeard: UInt64?

    public init(host: String, port: UInt16, key: MoshKey, cols: Int, rows: Int, callbackQueue: DispatchQueue = .main,
                onEvents: @escaping @Sendable ([HostEvent]) -> Void, onStatus: @escaping @Sendable (MoshStatus) -> Void) {
        self.host = NWEndpoint.Host(host)
        self.port = NWEndpoint.Port(rawValue: port) ?? .any
        self.cipher = PacketCipher(key: key)
        self.callbackQueue = callbackQueue
        self.onEvents = onEvents
        self.onStatus = onStatus
        // The server learns this client's address, and its window size, from the first datagram.
        events = [.resize(cols: cols, rows: rows)]
    }

    deinit {
        timer?.cancel()
        connection?.cancel()
    }

    public func start() {
        queue.async { [self] in
            started = Self.now()
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer
            timer.resume()
            hop()
        }
    }

    public func send(_ keys: [UInt8]) {
        guard !keys.isEmpty else { return }
        queue.async { [self] in
            guard !shuttingDown, !isClosed else { return }
            events.append(.keys(keys))
            tick()
        }
    }

    public func resize(cols: Int, rows: Int) {
        queue.async { [self] in
            guard !shuttingDown, !isClosed else { return }
            events.append(.resize(cols: cols, rows: rows))
            tick()
        }
    }

    /// Moves to a fresh UDP socket and tells the server where this client now is. Call it when
    /// the network path changes or the app returns to the foreground; Mosh does the rest.
    public func networkChanged() {
        queue.async { [self] in
            guard !isClosed else { return }
            hop()
        }
    }

    /// Ends the session: the server stops the program it runs and exits.
    public func close() {
        queue.async { [self] in
            guard !shuttingDown, !isClosed else { return }
            shuttingDown = true
            tick()
        }
    }

    // MARK: - Transport

    private var isClosed: Bool {
        if case .closed = status { return true }
        return false
    }

    private static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }

    private var sendInterval: UInt64 {
        min(max(UInt64((srtt / 2).rounded(.up)), Self.sendIntervalMin), Self.sendIntervalMax)
    }

    private var retransmitTimeout: UInt64 {
        UInt64(min(max(srtt + 4 * rttvar, 50), 1000))
    }

    private func hop() {
        connection?.cancel()
        let connection = NWConnection(host: host, port: port, using: .udp)
        self.connection = connection
        lastHop = Self.now()
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            if case .ready = state { self.receive(on: connection) }
        }
        connection.start(queue: queue)
        // Tell the server about the new address right away rather than at the next heartbeat.
        nextAckAt = 0
        tick()
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] data, _, _, error in
            guard let self, let connection, connection === self.connection else { return }
            if let data, self.dropDatagram?(false) != true { self.received([UInt8](data)) }
            if error == nil { self.receive(on: connection) }
        }
    }

    private func setStatus(_ new: MoshStatus) {
        guard new != status else { return }
        status = new
        callbackQueue.async { [onStatus] in onStatus(new) }
    }

    private func received(_ datagram: [UInt8]) {
        guard !isClosed, let packet = try? cipher.open(datagram), packet.toClient else { return }
        let now = Self.now()
        if packet.seq >= expectedSeq {
            expectedSeq = packet.seq + 1
            if packet.timestamp != Packet.noTimestamp {
                savedTimestamp = packet.timestamp
                savedTimestampAt = now
            }
            if packet.timestampReply != Packet.noTimestamp {
                let sample = Double(Self.timestamp16(now) &- packet.timestampReply)
                if sample < 5000 { observeRoundTrip(sample) }
            }
            lastHeard = now
            switch status {
            case .connecting, .unreachable: setStatus(.connected)
            case .connected, .closed: break
            }
        }
        guard let fragment = try? Fragment(decoding: packet.payload),
              let instruction = try? assembly.add(fragment) else { return }
        acknowledge(through: instruction.ackNum)
        if shuttingDown, sent[0].num == UInt64.max {
            finish(.clientClosed)
            return
        }
        guard instruction.newNum != remoteNum, instruction.oldNum == remoteNum else { return }
        remoteNum = instruction.newNum
        if !instruction.diff.isEmpty, let update = try? decodeHostMessage(instruction.diff), !update.isEmpty {
            callbackQueue.async { [onEvents] in onEvents(update) }
            nextAckAt = min(nextAckAt, now + Self.ackDelay)
        }
        if remoteNum == UInt64.max {
            // The server is shutting down; acknowledge so it can exit promptly.
            nextAckAt = 0
        }
        tick()
    }

    private func observeRoundTrip(_ sample: Double) {
        if !hasRTT {
            srtt = sample
            rttvar = sample / 2
            hasRTT = true
        } else {
            rttvar = 0.75 * rttvar + 0.25 * abs(srtt - sample)
            srtt = 0.875 * srtt + 0.125 * sample
        }
    }

    private func acknowledge(through num: UInt64) {
        guard let index = sent.firstIndex(where: { $0.num == num }) else { return }
        sent.removeFirst(index)
        let acknowledged = sent[0].end - eventsBase
        if acknowledged > 0 {
            events.removeFirst(acknowledged)
            eventsBase = sent[0].end
        }
    }

    private func tick() {
        guard connection != nil, !isClosed else { return }
        let now = Self.now()

        if remoteNum == UInt64.max, serverExitAcks >= 3 {
            finish(.serverExited)
            return
        }
        if shuttingDown, shutdownSends >= Self.shutdownTries {
            finish(.clientClosed)
            return
        }

        let heard = lastHeard ?? started
        if now - heard > Self.unreachableAfter, status != .connecting || now - started > 15_000 {
            let since = Date(timeIntervalSinceNow: -Double(now - heard) / 1000)
            if case .unreachable = status {} else { setStatus(.unreachable(since: since)) }
        }
        // Try a new local port when the server has gone quiet: it may be the path, not the server.
        if now - heard > Self.portHopInterval, now - lastHop > Self.portHopInterval {
            hop()
            return
        }

        let end = eventsBase + events.count
        let newData = end != sent[sent.count - 1].end
        let unacknowledged = end != sent[0].end
        if shuttingDown {
            if now >= lastSentAt + sendInterval { sendState(new: UInt64.max); shutdownSends += 1 }
        } else if remoteNum == UInt64.max {
            if now >= nextAckAt { sendState(new: sent[sent.count - 1].num + 1); serverExitAcks += 1; nextAckAt = now + sendInterval }
        } else if newData, now >= lastSentAt + sendInterval {
            sendState(new: sent[sent.count - 1].num + 1)
        } else if unacknowledged, now >= lastSentAt + retransmitTimeout + Self.ackDelay {
            sendState(new: sent[sent.count - 1].num)
        } else if now >= nextAckAt {
            sendState(new: unacknowledged && !newData ? sent[sent.count - 1].num : sent[sent.count - 1].num + 1)
        }
        schedule(now: now)
    }

    private func schedule(now: UInt64) {
        let end = eventsBase + events.count
        var wake = nextAckAt
        if shuttingDown || remoteNum == UInt64.max { wake = min(wake, lastSentAt + sendInterval) }
        if end != sent[sent.count - 1].end { wake = min(wake, lastSentAt + sendInterval) }
        if end != sent[0].end { wake = min(wake, lastSentAt + retransmitTimeout + Self.ackDelay) }
        let heard = lastHeard ?? started
        wake = min(wake, heard + Self.unreachableAfter + 1, max(heard, lastHop) + Self.portHopInterval + 1)
        let delay = wake > now ? wake - now : 1
        timer?.schedule(deadline: .now() + .milliseconds(Int(min(delay, 60_000))))
    }

    private func sendState(new num: UInt64) {
        guard let connection else { return }
        let acknowledged = sent[0]
        let end = eventsBase + events.count
        if num != sent[sent.count - 1].num {
            sent.append((num, end))
            // Bound the queue like Mosh: forget states in the middle, never the acknowledged one.
            if sent.count > 32 { sent.remove(at: sent.count - 17) }
        }
        let instruction = Instruction(oldNum: acknowledged.num, newNum: num, ackNum: remoteNum,
                                      throwawayNum: acknowledged.num,
                                      diff: end > acknowledged.end ? encodeUserMessage(events[(acknowledged.end - eventsBase)...]) : [])
        fragmentID &+= 1
        let now = Self.now()
        for fragment in Fragment.split(instruction, id: fragmentID, size: Self.fragmentSize) {
            let packet = Packet(seq: nextSeq, toClient: false, timestamp: Self.timestamp16(now),
                                timestampReply: timestampReply(now), payload: fragment.encoded())
            nextSeq += 1
            if dropDatagram?(true) == true { continue }
            connection.send(content: Data(cipher.seal(packet)), completion: .idempotent)
        }
        lastSentAt = now
        nextAckAt = now + Self.ackInterval
    }

    private func timestampReply(_ now: UInt64) -> UInt16 {
        guard let saved = savedTimestamp, now - savedTimestampAt < 1000 else { return Packet.noTimestamp }
        savedTimestamp = nil
        return saved &+ UInt16(now - savedTimestampAt)
    }

    private static func timestamp16(_ now: UInt64) -> UInt16 {
        let value = UInt16(truncatingIfNeeded: now)
        return value == Packet.noTimestamp ? 0 : value
    }

    private func finish(_ reason: MoshClosedReason) {
        setStatus(.closed(reason))
        timer?.cancel()
        timer = nil
        connection?.cancel()
        connection = nil
    }
}
