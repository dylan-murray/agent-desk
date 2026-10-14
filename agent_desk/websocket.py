"""The server half of RFC 6455 over the standard-library HTTP handler: text messages only."""
import base64
import binascii
import hashlib
import socket
import struct
import threading

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_MESSAGE = 1024 * 1024
TEXT, BINARY, CLOSE, PING, PONG = 1, 2, 8, 9, 10


class Closed(Exception):
    """The peer closed the connection, broke the protocol, or can no longer be written to."""


def upgrade_error(headers):
    """Why these request headers are not a WebSocket opening handshake, or None if they are."""
    if headers.get('Upgrade', '').lower() != 'websocket' or 'upgrade' not in headers.get('Connection', '').lower():
        return 'WebSocket upgrade required'
    if headers.get('Sec-WebSocket-Version') != '13':
        return 'Unsupported WebSocket version'
    try:
        if len(base64.b64decode(headers.get('Sec-WebSocket-Key', ''), validate=True)) != 16:
            raise ValueError
    except (ValueError, binascii.Error):
        return 'Invalid WebSocket key'
    return None


def accept(handler):
    """Switch an HTTP request that passed upgrade_error() to a WebSocket."""
    key = handler.headers['Sec-WebSocket-Key']
    digest = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    # Written directly: BaseHTTPRequestHandler would answer with its default HTTP/1.0 status line.
    handler.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                         f'Sec-WebSocket-Accept: {digest}\r\n\r\n').encode())
    handler.close_connection = True
    try:
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass
    return WebSocket(handler.rfile, handler.wfile)


def unmask(data, mask):
    if not data:
        return b''
    key = (mask * (len(data) // 4 + 1))[:len(data)]
    return (int.from_bytes(data, 'big') ^ int.from_bytes(key, 'big')).to_bytes(len(data), 'big')


class WebSocket:
    """One reader thread calls receive(); any thread may send."""

    def __init__(self, rfile, wfile):
        self.rfile, self.wfile = rfile, wfile
        self.lock = threading.Lock()
        self.closed = False

    def read(self, size):
        try:
            data = self.rfile.read(size)
        except OSError:
            data = b''
        if len(data) != size:
            self.closed = True
            raise Closed('Connection closed')
        return data

    def fail(self, code, reason):
        self.close(code, reason)
        raise Closed(reason)

    def receive(self):
        """The next text message, answering pings and closes on the way."""
        kind, message = None, bytearray()
        while True:
            first, second = self.read(2)
            final, opcode, length = first & 0x80, first & 0x0F, second & 0x7F
            if first & 0x70 or not second & 0x80:
                self.fail(1002, 'Client frames must be masked and use no extensions')
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            if opcode >= CLOSE and (not final or length > 125):
                self.fail(1002, 'Invalid control frame')
            if len(message) + length > MAX_MESSAGE:
                self.fail(1009, 'Message too large')
            mask = self.read(4)
            payload = unmask(self.read(length), mask)
            if opcode == CLOSE:
                self.close()
                raise Closed('Closed by peer')
            if opcode == PING:
                self.send(PONG, payload)
                continue
            if opcode == PONG:
                continue
            if opcode == 0 and kind is not None:
                message += payload
            elif opcode in (TEXT, BINARY) and kind is None:
                kind, message = opcode, bytearray(payload)
            else:
                self.fail(1002, 'Unexpected frame')
            if final:
                if kind != TEXT:
                    self.fail(1003, 'Only text messages are accepted')
                try:
                    return message.decode()
                except UnicodeDecodeError:
                    self.fail(1007, 'Invalid UTF-8')

    def send(self, opcode, payload):
        size = len(payload)
        header = bytes([0x80 | opcode]) + (bytes([size]) if size < 126 else struct.pack('!BH', 126, size) if size < 65536
                                           else struct.pack('!BQ', 127, size))
        with self.lock:
            if self.closed:
                raise Closed('Connection closed')
            try:
                self.wfile.write(header + payload)
            except OSError:
                self.closed = True
                raise Closed('Connection closed') from None
            if opcode == CLOSE:
                self.closed = True

    def send_text(self, text):
        self.send(TEXT, text.encode())

    def close(self, code=1000, reason=''):
        try:
            self.send(CLOSE, struct.pack('!H', code) + reason.encode()[:120])
        except Closed:
            pass
