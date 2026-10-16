import Foundation

/// The Mosh wire format below the state-synchronization layer: protobuf messages,
/// zlib framing, fragments and encrypted datagrams.

enum WireError: Error, Equatable {
    case truncated
    case unsupportedWireType(Int)
    case badCompression
    case badKey
    case unauthenticated
    case wrongDirection
    case protocolVersion(UInt32)
}

// MARK: - Protocol buffers

/// Just enough of the protobuf wire format for Mosh's three proto2 schemas.
struct ProtoWriter {
    private(set) var bytes: [UInt8] = []

    mutating func varint(_ value: UInt64) {
        var v = value
        while v >= 0x80 {
            bytes.append(UInt8(v & 0x7f) | 0x80)
            v >>= 7
        }
        bytes.append(UInt8(v))
    }

    mutating func field(_ number: Int, varint value: UInt64) {
        varint(UInt64(number << 3))
        varint(value)
    }

    mutating func field(_ number: Int, bytes value: [UInt8]) {
        varint(UInt64(number << 3 | 2))
        varint(UInt64(value.count))
        bytes += value
    }
}

struct ProtoReader {
    enum Value {
        case varint(UInt64)
        case bytes([UInt8])
        case fixed
    }

    private let bytes: [UInt8]
    private var index = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    private mutating func varint() throws -> UInt64 {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            guard index < bytes.count, shift < 64 else { throw WireError.truncated }
            let byte = bytes[index]
            index += 1
            result |= UInt64(byte & 0x7f) << shift
            if byte & 0x80 == 0 { return result }
            shift += 7
        }
    }

    private mutating func skip(_ count: Int) throws {
        guard count >= 0, bytes.count - index >= count else { throw WireError.truncated }
        index += count
    }

    /// The next field, or nil at the end of the message.
    mutating func next() throws -> (number: Int, value: Value)? {
        guard index < bytes.count else { return nil }
        let key = try varint()
        let number = Int(key >> 3)
        switch Int(key & 7) {
        case 0:
            return (number, .varint(try varint()))
        case 1:
            try skip(8)
            return (number, .fixed)
        case 2:
            let length = try varint()
            guard length <= UInt64(bytes.count - index) else { throw WireError.truncated }
            let start = index
            index += Int(length)
            return (number, .bytes(Array(bytes[start..<index])))
        case 5:
            try skip(4)
            return (number, .fixed)
        case let type:
            throw WireError.unsupportedWireType(type)
        }
    }
}

// MARK: - TransportBuffers.Instruction

/// One step of state synchronization: the diff that turns state `oldNum` into `newNum`.
struct Instruction: Equatable {
    static let protocolVersion: UInt32 = 2

    var protocolVersion = Instruction.protocolVersion
    var oldNum: UInt64 = 0
    var newNum: UInt64 = 0
    var ackNum: UInt64 = 0
    var throwawayNum: UInt64 = 0
    var diff: [UInt8] = []

    func encoded() -> [UInt8] {
        var writer = ProtoWriter()
        writer.field(1, varint: UInt64(protocolVersion))
        writer.field(2, varint: oldNum)
        writer.field(3, varint: newNum)
        writer.field(4, varint: ackNum)
        writer.field(5, varint: throwawayNum)
        writer.field(6, bytes: diff)
        return writer.bytes
    }

    init(oldNum: UInt64 = 0, newNum: UInt64 = 0, ackNum: UInt64 = 0, throwawayNum: UInt64 = 0, diff: [UInt8] = []) {
        self.oldNum = oldNum
        self.newNum = newNum
        self.ackNum = ackNum
        self.throwawayNum = throwawayNum
        self.diff = diff
    }

    init(decoding bytes: [UInt8]) throws {
        var reader = ProtoReader(bytes)
        protocolVersion = 0
        while let (number, value) = try reader.next() {
            switch (number, value) {
            case (1, .varint(let v)): protocolVersion = UInt32(truncatingIfNeeded: v)
            case (2, .varint(let v)): oldNum = v
            case (3, .varint(let v)): newNum = v
            case (4, .varint(let v)): ackNum = v
            case (5, .varint(let v)): throwawayNum = v
            case (6, .bytes(let v)): diff = v
            default: break // chaff (7) pads packets to hide their size
            }
        }
    }
}

// MARK: - Client and host messages

/// What the client sends: keystrokes and window sizes (ClientBuffers.UserMessage).
enum UserEvent: Equatable {
    case keys([UInt8])
    case resize(cols: Int, rows: Int)
}

func encodeUserMessage(_ events: ArraySlice<UserEvent>) -> [UInt8] {
    var message = ProtoWriter()
    for event in events {
        var instruction = ProtoWriter()
        switch event {
        case .keys(let keys):
            var keystroke = ProtoWriter()
            keystroke.field(4, bytes: keys)
            instruction.field(2, bytes: keystroke.bytes)
        case .resize(let cols, let rows):
            var resize = ProtoWriter()
            resize.field(5, varint: UInt64(cols))
            resize.field(6, varint: UInt64(rows))
            instruction.field(3, bytes: resize.bytes)
        }
        message.field(1, bytes: instruction.bytes)
    }
    return message.bytes
}

/// What the server sends: screen updates (HostBuffers.HostMessage).
public enum HostEvent: Equatable, Sendable {
    /// Terminal output that turns the previous screen into the new one.
    case output([UInt8])
    /// The server's screen is now this size; the output that follows assumes it.
    case resize(cols: Int, rows: Int)
}

func decodeHostMessage(_ bytes: [UInt8]) throws -> [HostEvent] {
    var events: [HostEvent] = []
    var message = ProtoReader(bytes)
    while let (number, value) = try message.next() {
        guard number == 1, case .bytes(let instructionBytes) = value else { continue }
        var instruction = ProtoReader(instructionBytes)
        while let (kind, body) = try instruction.next() {
            guard case .bytes(let bodyBytes) = body else { continue }
            var fields = ProtoReader(bodyBytes)
            switch kind {
            case 2:
                while let (n, v) = try fields.next() {
                    if n == 4, case .bytes(let output) = v { events.append(.output(output)) }
                }
            case 3:
                var cols = 0, rows = 0
                while let (n, v) = try fields.next() {
                    guard case .varint(let size) = v else { continue }
                    if n == 5 { cols = Int(Int32(truncatingIfNeeded: size)) }
                    if n == 6 { rows = Int(Int32(truncatingIfNeeded: size)) }
                }
                events.append(.resize(cols: cols, rows: rows))
            default:
                break // echo acknowledgements drive local echo prediction, which this client does not do
            }
        }
    }
    return events
}

// MARK: - zlib

/// Instructions travel zlib-compressed (RFC 1950). Foundation's .zlib is raw deflate, so the
/// two-byte header and the Adler-32 trailer are added and checked here.
enum Zlib {
    static func compress(_ bytes: [UInt8]) -> [UInt8] {
        let deflated = (try? (Data(bytes) as NSData).compressed(using: .zlib) as Data) ?? Data()
        var result: [UInt8] = [0x78, 0x9c]
        result += deflated
        let checksum = adler32(bytes)
        result += [UInt8(checksum >> 24), UInt8(checksum >> 16 & 0xff), UInt8(checksum >> 8 & 0xff), UInt8(checksum & 0xff)]
        return result
    }

    static func decompress(_ bytes: [UInt8]) throws -> [UInt8] {
        guard bytes.count >= 6, bytes[0] & 0x0f == 8, (UInt16(bytes[0]) << 8 | UInt16(bytes[1])) % 31 == 0,
              bytes[1] & 0x20 == 0 else { throw WireError.badCompression }
        let deflated = Data(bytes[2..<(bytes.count - 4)])
        guard let inflated = try? (deflated as NSData).decompressed(using: .zlib) as Data else { throw WireError.badCompression }
        let result = [UInt8](inflated)
        let trailer = bytes.suffix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        guard adler32(result) == trailer else { throw WireError.badCompression }
        return result
    }

    static func adler32(_ bytes: [UInt8]) -> UInt32 {
        var a: UInt32 = 1, b: UInt32 = 0
        var index = 0
        while index < bytes.count {
            // 5552 is the most bytes that can be summed before b can overflow 32 bits.
            let end = min(index + 5552, bytes.count)
            while index < end {
                a += UInt32(bytes[index])
                b += a
                index += 1
            }
            a %= 65521
            b %= 65521
        }
        return b << 16 | a
    }
}

// MARK: - Fragments

/// An instruction too large for one datagram is split into numbered fragments.
struct Fragment: Equatable {
    static let headerLength = 10

    var id: UInt64
    var number: UInt16
    var isFinal: Bool
    var contents: [UInt8]

    func encoded() -> [UInt8] {
        var bytes = withUnsafeBytes(of: id.bigEndian) { Array($0) }
        bytes += withUnsafeBytes(of: (number | (isFinal ? 0x8000 : 0)).bigEndian) { Array($0) }
        return bytes + contents
    }

    init(id: UInt64, number: UInt16, isFinal: Bool, contents: [UInt8]) {
        self.id = id
        self.number = number
        self.isFinal = isFinal
        self.contents = contents
    }

    init(decoding bytes: [UInt8]) throws {
        guard bytes.count >= Fragment.headerLength else { throw WireError.truncated }
        id = bytes[0..<8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        let combined = UInt16(bytes[8]) << 8 | UInt16(bytes[9])
        isFinal = combined & 0x8000 != 0
        number = combined & 0x7fff
        contents = Array(bytes[Fragment.headerLength...])
    }

    static func split(_ instruction: Instruction, id: UInt64, size: Int) -> [Fragment] {
        let payload = Zlib.compress(instruction.encoded())
        var fragments: [Fragment] = []
        var start = 0
        repeat {
            let end = min(start + size, payload.count)
            fragments.append(Fragment(id: id, number: UInt16(fragments.count), isFinal: end == payload.count,
                                      contents: Array(payload[start..<end])))
            start = end
        } while start < payload.count
        return fragments
    }
}

/// Collects the fragments of the instruction currently arriving. A fragment of a newer
/// instruction abandons an incomplete older one, as Mosh does.
struct FragmentAssembly {
    private var id: UInt64?
    private var pieces: [UInt16: [UInt8]] = [:]
    private var total: Int?

    mutating func add(_ fragment: Fragment) throws -> Instruction? {
        if fragment.id != id {
            id = fragment.id
            pieces = [:]
            total = nil
        }
        pieces[fragment.number] = fragment.contents
        if fragment.isFinal { total = Int(fragment.number) + 1 }
        guard let total, pieces.count == total else { return nil }
        let payload = (0..<total).flatMap { pieces[UInt16($0)] ?? [] }
        pieces = [:]
        self.total = nil
        let instruction = try Instruction(decoding: Zlib.decompress(payload))
        guard instruction.protocolVersion == Instruction.protocolVersion else {
            throw WireError.protocolVersion(instruction.protocolVersion)
        }
        return instruction
    }
}

// MARK: - Datagrams

/// The session key `mosh-server` prints: 22 characters of unpadded base64.
public struct MoshKey: Sendable, Equatable {
    let bytes: [UInt8]

    public init(_ printed: String) throws {
        guard printed.count == 22, let data = Data(base64Encoded: printed + "=="), data.count == 16 else {
            throw WireError.badKey
        }
        bytes = [UInt8](data)
    }
}

/// A decrypted datagram: Mosh's timestamps for round-trip estimates around a fragment.
struct Packet: Equatable {
    static let directionBit: UInt64 = 1 << 63
    static let noTimestamp: UInt16 = 0xffff

    var seq: UInt64
    var toClient: Bool
    var timestamp: UInt16
    var timestampReply: UInt16
    var payload: [UInt8]
}

/// Seals and opens datagrams with the session key. Bytes on the wire are the low 8 bytes of
/// the nonce (direction bit and sequence number), then the OCB ciphertext and tag.
final class PacketCipher {
    private let ocb: OCB

    init(key: MoshKey) { ocb = OCB(key: key.bytes) }

    func seal(_ packet: Packet) -> [UInt8] {
        let directionSeq = (packet.toClient ? Packet.directionBit : 0) | (packet.seq & ~Packet.directionBit)
        let nonceTail = withUnsafeBytes(of: directionSeq.bigEndian) { Array($0) }
        var plaintext = withUnsafeBytes(of: packet.timestamp.bigEndian) { Array($0) }
        plaintext += withUnsafeBytes(of: packet.timestampReply.bigEndian) { Array($0) }
        plaintext += packet.payload
        return nonceTail + ocb.seal(nonce: [0, 0, 0, 0] + nonceTail, plaintext: plaintext)
    }

    func open(_ datagram: [UInt8]) throws -> Packet {
        guard datagram.count >= 8 + OCB.tagLength + 4 else { throw WireError.truncated }
        let nonceTail = Array(datagram[0..<8])
        guard let plaintext = ocb.open(nonce: [0, 0, 0, 0] + nonceTail, sealed: Array(datagram[8...])) else {
            throw WireError.unauthenticated
        }
        let directionSeq = nonceTail.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        return Packet(seq: directionSeq & ~Packet.directionBit, toClient: directionSeq & Packet.directionBit != 0,
                      timestamp: UInt16(plaintext[0]) << 8 | UInt16(plaintext[1]),
                      timestampReply: UInt16(plaintext[2]) << 8 | UInt16(plaintext[3]),
                      payload: Array(plaintext[4...]))
    }
}
