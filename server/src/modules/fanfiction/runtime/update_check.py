"""Bind fast metadata checks and download checkpoints to the installed edition."""
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
        # Tag decisions must refresh EPUB metadata, but do not change downloaded
        # chapter bodies. Keep those checkpoints reusable while labels are reviewed.
        chapter_payload = {key: value for key, value in payload.items() if key != 'tagMatching'}
        matched_fields = {'tags', 'genres', 'categories', 'pendingLabelCount', 'labelMappingVersion'}
        chapter_payload['preview'] = {key: value for key, value in preview.items() if key not in matched_fields}
        self.chapter_fingerprint = hashlib.sha256(json.dumps(chapter_payload, sort_keys=True, default=str).encode()).hexdigest()
        self.input_hash = file_hash('input.epub') if request['operation'] in ('update', 'refresh') else None
        self.resume_directory = None
        if request['operation'] == 'download':
            config_hash = hashlib.sha256(payload['configuration'].encode()).hexdigest()
            self.resume_directory = 'import-' + config_hash
        elif self.input_hash and request.get('checkpointJobId'):
            # Resume the same update across pauses, even after the verification week changes.
            identity = [request['checkpointJobId'], request['operation'], self.input_hash, payload['configuration']]
            self.resume_directory = 'job-' + hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        self.saved = {}
        if self.path:
            try:
                if self.path.stat().st_size <= 4096:
                    saved = json.loads(self.path.read_text())
                    if isinstance(saved, dict):
                        self.saved = saved
            except (OSError, ValueError):
                pass

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
        identity = f'{self.chapter_fingerprint}:{self.input_hash}:{int(self.now // VERIFY_INTERVAL)}'
        current = Path(directory) / hashlib.sha256(identity.encode()).hexdigest()
        legacy_identity = f'{self.fingerprint}:{self.input_hash}:{int(self.now // VERIFY_INTERVAL)}'
        legacy = Path(directory) / hashlib.sha256(legacy_identity.encode()).hexdigest()
        # Migrate only a checkpoint matching the current full source fingerprint.
        # Other old folders may contain stale source text and must not be reused.
        if not current.exists() and legacy.is_dir():
            try:
                legacy.rename(current)
            except FileExistsError:
                pass
        if self.resume_directory:
            target = Path(directory) / self.resume_directory
            if not target.exists() and current.is_dir():
                try:
                    current.rename(target)
                except FileExistsError:
                    pass
            return str(target)
        return str(current)

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
