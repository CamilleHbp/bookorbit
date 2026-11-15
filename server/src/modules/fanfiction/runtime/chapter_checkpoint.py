"""Durable chapter records with content-addressed illustrations and legacy reads."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

MAX_BODY = 16 * 1024 * 1024
MAX_HEADER = 2 * 1024 * 1024
MAX_RECORD = MAX_BODY + MAX_HEADER + 65536


class CheckpointStorageError(OSError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_bounded(path, maximum):
    try:
        with path.open('rb') as stream:
            data = stream.read(maximum + 1)
        return data if len(data) <= maximum else None
    except FileNotFoundError:
        return None
    except OSError as error:
        raise CheckpointStorageError(error.errno, error.strerror) from error


def sync_directory(path):
    directory = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def ensure_directory(path):
    if path.is_dir():
        return
    ensure_directory(path.parent)
    path.mkdir(mode=0o700, exist_ok=True)
    sync_directory(path.parent)


def atomic_write(path, data):
    temporary = None
    try:
        ensure_directory(path.parent)
        fd, temporary = tempfile.mkstemp(prefix='.checkpoint-', dir=path.parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    except OSError as error:
        raise CheckpointStorageError(error.errno, error.strerror) from error
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


class ChapterCheckpoint:
    def __init__(self, directory):
        self.path = Path(directory)
        self.root = self.path / 'v2'
        self.legacy = None
        self.verified_images = set()

    def close(self):
        if self.legacy is not None:
            self.legacy.close()

    def legacy_db(self):
        path = self.path / 'chapters.sqlite'
        if self.legacy is None and path.exists():
            self.legacy = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=15)
        return self.legacy

    def record_path(self, key):
        return self.root / 'chapters' / key[0] / (key[1] + '.chapter')

    def load(self, key):
        data = read_bounded(self.record_path(key), MAX_RECORD)
        if data and len(data) >= 4:
            size = int.from_bytes(data[:4], 'big')
            if 0 < size <= MAX_HEADER and len(data) >= size + 4:
                try:
                    header = json.loads(data[4:4 + size])
                    body = data[4 + size:]
                    references = header['images']
                    if header['version'] == 2 and digest(body + references.encode()) == header['checksum']:
                        return body, references, False
                except (ValueError, KeyError, TypeError, AttributeError):
                    pass  # Incomplete or damaged records are downloaded again.
        legacy = self.legacy_db()
        if legacy is not None:
            row = legacy.execute('SELECT body,checksum,images FROM chapters WHERE story=? AND url=?', key).fetchone()
            if row and digest(row[0] + row[2].encode()) == row[1]:
                return row[0], row[2], True
        return None

    def image_path(self, checksum):
        if len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum):
            return None
        return self.root / 'images' / checksum[:2] / checksum[2:]

    def image(self, checksum):
        path = self.image_path(checksum)
        if path is None:
            return None
        data = read_bounded(path, MAX_BODY)
        if data is not None and digest(data) == checksum:
            return data
        legacy = self.legacy_db()
        if legacy is not None:
            row = legacy.execute('SELECT data FROM images WHERE checksum=?', (checksum,)).fetchone()
            if row and len(row[0]) <= MAX_BODY and digest(row[0]) == checksum:
                self.put_image(row[0])
                return row[0]
        return None

    def put_image(self, data):
        checksum = digest(data)
        if checksum not in self.verified_images:
            path = self.image_path(checksum)
            existing = read_bounded(path, MAX_BODY)
            if existing is None or digest(existing) != checksum:
                atomic_write(path, data)
            self.verified_images.add(checksum)
        return checksum

    def save(self, key, body, references):
        header = json.dumps({'version': 2, 'checksum': digest(body + references.encode()), 'images': references}).encode()
        if len(header) > MAX_HEADER or len(body) + len(header) + 4 > MAX_RECORD:
            from safe_transport import DownloadLimitError
            raise DownloadLimitError('Chapter recovery record exceeds the chapter size limit')
        # Illustrations are durable before the chapter becomes reusable.
        atomic_write(self.record_path(key), len(header).to_bytes(4, 'big') + header + body)
