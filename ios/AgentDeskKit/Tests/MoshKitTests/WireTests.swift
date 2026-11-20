import Foundation
import Testing
@testable import MoshKit

private func hex(_ string: String) -> [UInt8] {
    var bytes: [UInt8] = []
    var index = string.startIndex
    while index < string.endIndex {
        let next = string.index(index, offsetBy: 2)
        bytes.append(UInt8(string[index..<next], radix: 16)!)
        index = next
    }
    return bytes
}

/// RFC 7253 Appendix A: key 000102...0F, nonces BBAA99887766554433221100 upward, and the
/// associated data and plaintext both counting up from 00 to the given lengths.
private let rfc7253: [(nonce: String, ad: Int, plaintext: Int, sealed: String)] = [
    ("BBAA99887766554433221100", 0, 0, "785407BFFFC8AD9EDCC5520AC9111EE6"),
    ("BBAA99887766554433221101", 8, 8, "6820B3657B6F615A5725BDA0D3B4EB3A257C9AF1F8F03009"),
    ("BBAA99887766554433221102", 8, 0, "81017F8203F081277152FADE694A0A00"),
    ("BBAA99887766554433221103", 0, 8, "45DD69F8F5AAE72414054CD1F35D82760B2CD00D2F99BFA9"),
    ("BBAA99887766554433221104", 16, 16, "571D535B60B277188BE5147170A9A22C3AD7A4FF3835B8C5701C1CCEC8FC3358"),
    ("BBAA99887766554433221105", 16, 0, "8CF761B6902EF764462AD86498CA6B97"),
    ("BBAA99887766554433221106", 0, 16, "5CE88EC2E0692706A915C00AEB8B2396F40E1C743F52436BDF06D8FA1ECA343D"),
    ("BBAA99887766554433221107", 24, 24, "1CA2207308C87C010756104D8840CE1952F09673A448A122C92C62241051F57356D7F3C90BB0E07F"),
    ("BBAA99887766554433221108", 24, 0, "6DC225A071FC1B9F7C69F93B0F1E10DE"),
    ("BBAA99887766554433221109", 0, 24, "221BD0DE7FA6FE993ECCD769460A0AF2D6CDED0C395B1C3CE725F32494B9F914D85C0B1EB38357FF"),
    ("BBAA9988776655443322110A", 32, 32, "BD6F6C496201C69296C11EFD138A467ABD3C707924B964DEAFFC40319AF5A48540FBBA186C5553C68AD9F592A79A4240"),
    ("BBAA9988776655443322110B", 40, 40, "B21DCBAAEF103229041D0A290F6BE0D7CC75EED9E3D194576AC49F46E1E5E277879D4EF78CBF4295B101F64D2B5A6D2DBC6B492839818458"),
    ("BBAA9988776655443322110E", 0, 40, "EEAFDD610FEBE0C6715A6F19308E5F741FE2C0614560442E326977DEE48846B55A36EA4F551A1D34C45BD32EDA5B88BA680ECB7C3D7E3D8C"),
    ("BBAA9988776655443322110F", 40, 0, "CDF8590DC24B9EFDAACBECD8959E7A7B"),
]

@Test(arguments: rfc7253)
func ocbMatchesRFC7253(vector: (nonce: String, ad: Int, plaintext: Int, sealed: String)) {
    let ocb = OCB(key: Array(0..<16))
    let ad = (0..<vector.ad).map(UInt8.init), plaintext = (0..<vector.plaintext).map(UInt8.init)
    let sealed = ocb.seal(nonce: hex(vector.nonce), plaintext: plaintext, associatedData: ad)
    #expect(sealed == hex(vector.sealed))
    #expect(ocb.open(nonce: hex(vector.nonce), sealed: sealed, associatedData: ad) == plaintext)
}

@Test func ocbRejectsAnyTamperedByte() {
    let ocb = OCB(key: Array(0..<16))
    let nonce = Array(repeating: UInt8(7), count: 12)
    let sealed = ocb.seal(nonce: nonce, plaintext: Array("keystrokes".utf8))
    for index in sealed.indices {
        var tampered = sealed
        tampered[index] ^= 0x01
        #expect(ocb.open(nonce: nonce, sealed: tampered) == nil)
    }
    #expect(ocb.open(nonce: Array(repeating: 8, count: 12), sealed: sealed) == nil)
}

@Test func ocbRoundTripsEveryLengthAcrossBlockBoundaries() {
    let ocb = OCB(key: Array(repeating: 0x42, count: 16))
    for length in 0...130 {
        let plaintext = (0..<length).map { UInt8(truncatingIfNeeded: $0 &* 31) }
        let nonce = (0..<12).map { UInt8(truncatingIfNeeded: length + $0) }
        #expect(ocb.open(nonce: nonce, sealed: ocb.seal(nonce: nonce, plaintext: plaintext)) == plaintext)
    }
}

@Test func instructionsRoundTripIncludingTheShutdownNumber() throws {
    let instruction = Instruction(oldNum: 3, newNum: UInt64.max, ackNum: 300, throwawayNum: 3, diff: [1, 2, 3])
    #expect(try Instruction(decoding: instruction.encoded()) == instruction)
    // Fields the client does not read, like chaff, are skipped.
    var writer = ProtoWriter()
    writer.field(7, bytes: [9, 9, 9])
    let withChaff = try Instruction(decoding: instruction.encoded() + writer.bytes)
    #expect(withChaff == instruction)
}

@Test func userMessagesUseMoshFieldNumbers() {
    // UserMessage{instruction{keystroke(2){keys(4)}}, instruction{resize(3){width(5), height(6)}}}
    let encoded = encodeUserMessage([.keys([0x61]), .resize(cols: 120, rows: 40)][...])
    #expect(encoded == [0x0a, 0x05, 0x12, 0x03, 0x22, 0x01, 0x61,
                        0x0a, 0x06, 0x1a, 0x04, 0x28, 0x78, 0x30, 0x28])
}

@Test func hostMessagesDecodeOutputResizesAndSkipEchoAcks() throws {
    var hostBytes = ProtoWriter(); hostBytes.field(4, bytes: Array("hi".utf8))
    var resize = ProtoWriter(); resize.field(5, varint: 100); resize.field(6, varint: 30)
    var echo = ProtoWriter(); echo.field(8, varint: 12)
    var message = ProtoWriter()
    for (field, body) in [(3, resize.bytes), (2, hostBytes.bytes), (7, echo.bytes)] {
        var instruction = ProtoWriter(); instruction.field(field, bytes: body)
        message.field(1, bytes: instruction.bytes)
    }
    #expect(try decodeHostMessage(message.bytes) == [.resize(cols: 100, rows: 30), .output(Array("hi".utf8))])
}

@Test func zlibFramingIsStandard() throws {
    let text = Array(String(repeating: "agent desk ", count: 400).utf8)
    let compressed = Zlib.compress(text)
    #expect(compressed.count < text.count / 10)
    #expect(try Zlib.decompress(compressed) == text)
    // zlib.compress(b"hello") from Python's zlib, a reference implementation.
    #expect(try Zlib.decompress(hex("789CCB48CDC9C90700062C0215")) == Array("hello".utf8))
    #expect(Zlib.adler32(Array("Wikipedia".utf8)) == 0x11E60398)
    var corrupt = compressed
    corrupt[corrupt.count - 1] ^= 1
    #expect(throws: WireError.badCompression) { try Zlib.decompress(corrupt) }
}

@Test func largeInstructionsSplitAndReassembleInAnyOrder() throws {
    let instruction = Instruction(oldNum: 1, newNum: 2, ackNum: 5, throwawayNum: 1,
                                  diff: (0..<20_000).map { _ in UInt8.random(in: 0...255) })
    let fragments = Fragment.split(instruction, id: 9, size: 1000)
    #expect(fragments.count > 10)
    #expect(fragments.last?.isFinal == true && fragments.dropLast().allSatisfy { !$0.isFinal })
    var assembly = FragmentAssembly()
    var result: Instruction?
    for fragment in fragments.reversed() {
        #expect(result == nil)
        result = try assembly.add(Fragment(decoding: fragment.encoded()))
    }
    #expect(result == instruction)
}

@Test func packetsCarryDirectionSequenceAndTimestamps() throws {
    let cipher = PacketCipher(key: try MoshKey("QUFBQUFBQUFBQUFBQUFBQQ"))
    let packet = Packet(seq: 41, toClient: true, timestamp: 1234, timestampReply: Packet.noTimestamp, payload: [1, 2])
    let datagram = cipher.seal(packet)
    #expect(Array(datagram[0..<8]) == [0x80, 0, 0, 0, 0, 0, 0, 41])
    #expect(try cipher.open(datagram) == packet)
    let other = PacketCipher(key: try MoshKey("QkJCQkJCQkJCQkJCQkJCQg"))
    #expect(throws: WireError.unauthenticated) { try other.open(datagram) }
    #expect(throws: WireError.badKey) { try MoshKey("short") }
}
