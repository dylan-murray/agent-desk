"""Bounded desktop diagnostics; conversation and application stores are unaffected."""
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

from agent_desk.local_transport import private_directory

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
RETENTION_SECONDS = 14 * 24 * 60 * 60
LOG_NAME = re.compile(r'desktop-(backend|bootstrap)(\.[\w.-]+)?\.log')


class DiagnosticHandler(RotatingFileHandler):
    def __init__(self, directory, *, max_bytes=MAX_FILE_BYTES,
                 max_total=MAX_TOTAL_BYTES, clock=time.time):
        self.directory = private_directory(Path(directory).absolute())
        self.clock = clock
        self.max_total = max_total
        self.last_cleanup = 0
        filename = self.directory / 'desktop-backend.log'
        modified = filename.lstat().st_mtime if filename.exists() else clock()
        self.day = time.gmtime(modified)[:3]
        super().__init__(filename, maxBytes=max_bytes, encoding='utf-8', delay=True)
        self.terminator = ''
        self.prune()

    def _open(self):
        fd = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(fd)
            raise PermissionError('Unsafe desktop diagnostic log')
        return os.fdopen(fd, 'a', encoding='utf-8')

    def shouldRollover(self, record):
        now = self.clock()
        if now - self.last_cleanup >= 3600:
            self.prune()
        if self.stream is None:
            self.stream = self._open()
        size = os.fstat(self.stream.fileno()).st_size
        return bool(size and (time.gmtime(now)[:3] != self.day or
                             size + len(self.format(record).encode('utf-8')) > self.maxBytes))

    def doRollover(self):
        if self.stream:
            self.stream.close()
            self.stream = None
        archive = self.directory / f'desktop-backend.{int(self.clock() * 1000)}.{uuid.uuid4().hex}.log'
        os.replace(self.baseFilename, archive)
        self.day = time.gmtime(self.clock())[:3]
        self.prune()

    def prune(self):
        now = self.clock()
        files = []
        for file in self.directory.iterdir():
            if not LOG_NAME.fullmatch(file.name) or file.name in ('desktop-backend.log', 'desktop-bootstrap.log'):
                continue
            info = file.lstat()
            if stat.S_ISREG(info.st_mode):
                files.append((info.st_mtime, info.st_size, file))
        total = sum(size for _, size, _ in files)
        # Reserve space for both active files and the overwritten startup metrics.
        budget = max(0, self.max_total - 2 * self.maxBytes - 1024)
        for modified, size, file in sorted(files):
            if modified < now - RETENTION_SECONDS or total > budget:
                file.unlink()
                total -= size
        self.last_cleanup = now

    def handleError(self, record):
        # A full disk must not recursively log through redirected stderr.
        try: os.write(2, b'Desktop diagnostic log write failed.\n')
        except OSError: pass


class DiagnosticStream:
    encoding = 'utf-8'
    errors = 'replace'

    def __init__(self, handler):
        self.handler = handler

    def write(self, text):
        # Bound individual records as well as files, including Unicode output.
        step = max(1, self.handler.maxBytes // 4)
        for offset in range(0, len(text), step):
            self.handler.handle(logging.LogRecord('desktop', logging.INFO, '', 0, text[offset:offset + step], (), None))
        return len(text)

    def flush(self):
        self.handler.flush()

    def isatty(self):
        return False


def configure(directory):
    handler = DiagnosticHandler(directory)
    sys.stdout = sys.stderr = DiagnosticStream(handler)
    return handler
