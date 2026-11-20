import CommonCrypto
import Foundation

/// AES-128 in OCB3 mode (RFC 7253) with a 128-bit tag: the authenticated cipher Mosh
/// uses for every datagram. Not thread-safe; each Mosh connection owns one.
final class OCB {
    static let tagLength = 16
    private static let zero = [UInt8](repeating: 0, count: 16)

    private let encryptor: CCCryptorRef
    private let decryptor: CCCryptorRef
    private let lStar: [UInt8]
    private let lDollar: [UInt8]
    private var l: [[UInt8]]

    init(key: [UInt8]) {
        precondition(key.count == 16, "OCB needs a 128-bit AES key")
        encryptor = OCB.cryptor(kCCEncrypt, key)
        decryptor = OCB.cryptor(kCCDecrypt, key)
        lStar = OCB.ecb(encryptor, OCB.zero)
        lDollar = OCB.double(lStar)
        l = [OCB.double(lDollar)]
    }

    deinit {
        CCCryptorRelease(encryptor)
        CCCryptorRelease(decryptor)
    }

    /// The ciphertext followed by the tag.
    func seal(nonce: [UInt8], plaintext: [UInt8], associatedData: [UInt8] = []) -> [UInt8] {
        var offset = initialOffset(nonce)
        var checksum = OCB.zero
        let full = plaintext.count / 16
        var input = [UInt8](repeating: 0, count: full * 16)
        var offsets = [UInt8](repeating: 0, count: full * 16)
        for i in 0..<full {
            offset = OCB.xor(offset, lFor(i + 1))
            for j in 0..<16 {
                let p = plaintext[i * 16 + j]
                input[i * 16 + j] = p ^ offset[j]
                offsets[i * 16 + j] = offset[j]
                checksum[j] ^= p
            }
        }
        var output = full > 0 ? OCB.ecb(encryptor, input) : []
        for k in 0..<output.count { output[k] ^= offsets[k] }
        let rest = plaintext.count % 16
        if rest > 0 {
            offset = OCB.xor(offset, lStar)
            let pad = OCB.ecb(encryptor, offset)
            for j in 0..<rest {
                let p = plaintext[full * 16 + j]
                output.append(p ^ pad[j])
                checksum[j] ^= p
            }
            checksum[rest] ^= 0x80
        }
        let tag = OCB.xor(OCB.ecb(encryptor, OCB.xor(OCB.xor(checksum, offset), lDollar)), hash(associatedData))
        return output + tag
    }

    /// The plaintext, or nil when the tag does not authenticate the ciphertext.
    func open(nonce: [UInt8], sealed: [UInt8], associatedData: [UInt8] = []) -> [UInt8]? {
        guard sealed.count >= OCB.tagLength else { return nil }
        let length = sealed.count - OCB.tagLength
        var offset = initialOffset(nonce)
        var checksum = OCB.zero
        let full = length / 16
        var input = [UInt8](repeating: 0, count: full * 16)
        var offsets = [UInt8](repeating: 0, count: full * 16)
        for i in 0..<full {
            offset = OCB.xor(offset, lFor(i + 1))
            for j in 0..<16 {
                input[i * 16 + j] = sealed[i * 16 + j] ^ offset[j]
                offsets[i * 16 + j] = offset[j]
            }
        }
        var plaintext = full > 0 ? OCB.ecb(decryptor, input) : []
        for k in 0..<plaintext.count {
            plaintext[k] ^= offsets[k]
            checksum[k % 16] ^= plaintext[k]
        }
        let rest = length % 16
        if rest > 0 {
            offset = OCB.xor(offset, lStar)
            let pad = OCB.ecb(encryptor, offset)
            for j in 0..<rest {
                let p = sealed[full * 16 + j] ^ pad[j]
                plaintext.append(p)
                checksum[j] ^= p
            }
            checksum[rest] ^= 0x80
        }
        let tag = OCB.xor(OCB.ecb(encryptor, OCB.xor(OCB.xor(checksum, offset), lDollar)), hash(associatedData))
        var difference: UInt8 = 0
        for j in 0..<OCB.tagLength { difference |= tag[j] ^ sealed[length + j] }
        return difference == 0 ? plaintext : nil
    }

    private func lFor(_ index: Int) -> [UInt8] {
        let ntz = index.trailingZeroBitCount
        while l.count <= ntz { l.append(OCB.double(l[l.count - 1])) }
        return l[ntz]
    }

    private func initialOffset(_ nonce: [UInt8]) -> [UInt8] {
        precondition(nonce.count == 12, "Mosh uses 96-bit OCB nonces")
        var block: [UInt8] = [0, 0, 0, 1] + nonce
        let bottom = Int(block[15] & 0x3f)
        block[15] &= 0xc0
        let top = OCB.ecb(encryptor, block)
        let stretch = top + (0..<8).map { top[$0] ^ top[$0 + 1] }
        let bytes = bottom / 8, bits = bottom % 8
        return (0..<16).map { i in
            bits == 0 ? stretch[i + bytes] : (stretch[i + bytes] << bits) | (stretch[i + bytes + 1] >> (8 - bits))
        }
    }

    private func hash(_ data: [UInt8]) -> [UInt8] {
        var sum = OCB.zero, offset = OCB.zero
        let full = data.count / 16
        for i in 0..<full {
            offset = OCB.xor(offset, lFor(i + 1))
            sum = OCB.xor(sum, OCB.ecb(encryptor, OCB.xor(Array(data[i * 16..<i * 16 + 16]), offset)))
        }
        let rest = data.count % 16
        if rest > 0 {
            offset = OCB.xor(offset, lStar)
            var last = Array(data[(full * 16)...]) + [0x80]
            last += [UInt8](repeating: 0, count: 16 - last.count)
            sum = OCB.xor(sum, OCB.ecb(encryptor, OCB.xor(last, offset)))
        }
        return sum
    }

    private static func double(_ block: [UInt8]) -> [UInt8] {
        var result = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 {
            result[i] = block[i] << 1 | (i < 15 ? block[i + 1] >> 7 : 0)
        }
        if block[0] & 0x80 != 0 { result[15] ^= 0x87 }
        return result
    }

    private static func xor(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        (0..<16).map { a[$0] ^ b[$0] }
    }

    private static func cryptor(_ operation: Int, _ key: [UInt8]) -> CCCryptorRef {
        var ref: CCCryptorRef?
        let status = CCCryptorCreate(CCOperation(operation), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
                                     key, key.count, nil, &ref)
        guard status == kCCSuccess, let ref else { fatalError("CommonCrypto refused an AES-128 key: \(status)") }
        return ref
    }

    /// Enciphers or deciphers whole blocks independently (ECB), the block primitive OCB is built on.
    private static func ecb(_ cryptor: CCCryptorRef, _ blocks: [UInt8]) -> [UInt8] {
        var output = [UInt8](repeating: 0, count: blocks.count)
        var moved = 0
        let status = CCCryptorUpdate(cryptor, blocks, blocks.count, &output, output.count, &moved)
        precondition(status == kCCSuccess && moved == blocks.count, "AES block operation failed: \(status)")
        return output
    }
}
