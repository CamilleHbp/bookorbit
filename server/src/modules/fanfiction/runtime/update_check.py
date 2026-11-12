"""Bound fast checks to the exact saved EPUB and periodically verify source text."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

VERIFY_INTERVAL = 7 * 24 * 60 * 60


def file_hash(path):
    with open(path, 'rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


class UpdateCheck:
    def __init__(self, request, adapter, preview):
        self.path = Path(request['checkStatePath']) if request.get('checkStatePath') else None
        self.now = time.time()
        # Include configuration and mapping changes without persisting credentials.
        payload = {
            'version': 1, 'preview': preview, 'chapters': adapter.get_chapters(),
            'updated': str(adapter.story.getMetadataRaw('dateUpdated')),
            'configuration': request.get('configuration', ''),
            'tagMatching': request.get('tagMatching'),
            'images': [hashlib.sha256(image['data']).hexdigest()
                       for image in adapter.story.img_store.get_imgs()],
        }
        self.fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
        self.saved = {}
        if self.path:
            try:
                if self.path.stat().st_size <= 4096:
                    saved = json.loads(self.path.read_text())
                    if isinstance(saved, dict):
                        self.saved = saved
            except (OSError, ValueError):
                pass
        self.input_hash = file_hash('input.epub') if request['operation'] in ('update', 'refresh') else None

    def unchanged(self):
        verified = self.saved.get('verifiedAt')
        return bool(self.path and self.input_hash and
                    self.saved.get('epubHash') == self.input_hash and
                    self.saved.get('fingerprint') == self.fingerprint and
                    isinstance(verified, (int, float)) and
                    0 <= self.now - verified < VERIFY_INTERVAL)

    def chapter_directory(self, directory):
        if not directory or not self.path:
            return directory
        # A failed verification can resume, but cannot reuse chapters from an older
        # source fingerprint, installed revision, or periodic verification window.
        identity = f'{self.fingerprint}:{self.input_hash}:{int(self.now // VERIFY_INTERVAL)}'
        return str(Path(directory) / hashlib.sha256(identity.encode()).hexdigest())

    def save(self, output):
        if not self.path:
            return
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        state = {'fingerprint': self.fingerprint, 'epubHash': file_hash(output), 'verifiedAt': self.now}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent, delete=False) as file:
                temporary = file.name
                json.dump(state, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
