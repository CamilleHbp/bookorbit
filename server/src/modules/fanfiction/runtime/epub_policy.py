from pathlib import PurePosixPath
from zipfile import ZipFile

from safe_transport import PolicyError


def validate_epub(path):
    with ZipFile(path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 10_000:
            raise PolicyError('Archive entry limit exceeded')
        names = set()
        expanded = 0
        for entry in entries:
            name = entry.filename
            parts = PurePosixPath(name).parts
            if not name or name in names or name.startswith('/') or '\\' in name or '..' in parts or ':' in name or any(ord(c) < 32 for c in name):
                raise PolicyError('Unsafe EPUB entry path')
            names.add(name)
            expanded += entry.file_size
            if entry.flag_bits & 1 or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise PolicyError('Encrypted entries and links are disabled')
            if entry.file_size > 16 * 1024 * 1024 or expanded > 256 * 1024 * 1024 or entry.file_size > max(1, entry.compress_size) * 500:
                raise PolicyError('Archive expansion limit exceeded')
        if 'mimetype' not in names or 'META-INF/container.xml' not in names or archive.read('mimetype') != b'application/epub+zip':
            raise PolicyError('Invalid EPUB structure')
        return len(entries)
