"""Atomic recovery of completed FanFicFare chapters and the illustrations they use."""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import zlib
from contextlib import closing, contextmanager

from controlled_config import check_storiesonline_notice, StoriesOnlinePreview
from safe_transport import DownloadLimitError, SourceResponseError

# FanFicFare uses a URL-derived UUID for inline illustrations and CSS assets.
IMAGE = re.compile(r'images/ffdl-([0-9a-fA-F-]+)\.([a-zA-Z0-9]+)')
MAX_BODY = 16 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def recover_chapters(adapter, directory, canonical, transport):
    if not directory:
        yield None
        return
    path = Path(directory)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    with closing(sqlite3.connect(path / 'chapters.sqlite', timeout=15)) as db:
        db.execute('pragma synchronous=FULL')
        db.execute('pragma max_page_count=65000')  # Leave room below the runtime file-size limit.
        db.executescript("""
            CREATE TABLE IF NOT EXISTS chapters (
              story TEXT, url TEXT, body BLOB NOT NULL, checksum TEXT NOT NULL, images TEXT NOT NULL,
              PRIMARY KEY(story, url)
            );
            CREATE TABLE IF NOT EXISTS images (checksum TEXT PRIMARY KEY, data BLOB NOT NULL);
        """)
        downloaded = 0
        original = adapter.getChapterTextNum
        story_key = digest(canonical.encode())

        occurrences = {}
        duplicates = {}
        for index, info in enumerate(adapter.get_chapters()):
            url = adapter.normalize_chapterurl(info['url'])
            count = occurrences.get(url, 0)
            if count:
                duplicates[index] = count
            occurrences[url] = count + 1

        def chapter(url, index):
            nonlocal downloaded
            identity = adapter.normalize_chapterurl(url)
            if index in duplicates:
                identity += '\0' + str(duplicates[index])
            key = (story_key, digest(identity.encode()))
            row = db.execute('SELECT body,checksum,images FROM chapters WHERE story=? AND url=?', key).fetchone()
            if row:
                body, checksum, references = row
                if digest(body + references.encode()) == checksum:
                    stored = zlib.decompress(body)
                    try:
                        check_storiesonline_notice(canonical, stored)
                    except StoriesOnlinePreview:
                        # Checkpoints written before preview detection must be fetched again.
                        with db:
                            db.execute('DELETE FROM chapters WHERE story=? AND url=?', key)
                    else:
                        replacements = {}
                        for name, image_hash, ext, mime in json.loads(references):
                            image = db.execute('SELECT data FROM images WHERE checksum=?', (image_hash,)).fetchone()
                            if not image or digest(image[0]) != image_hash:
                                break
                            restored = adapter.story.img_store.add_img(name, ext, mime, image[0])
                            replacements[name] = restored['newsrc']
                        else:
                            return IMAGE.sub(lambda match: replacements.get(match.group(), match.group()), stored.decode('utf-8'))
            html = original(url, index)
            if transport.failure is not None:
                raise transport.failure
            # FictionLiveAdapter returns exactly '' for a successful empty JSON range.
            # Keep the chapter in the spine but recheck it on a later download.
            if html == '' and adapter.getSiteDomain() == 'fiction.live':
                downloaded += 1
                return '<div></div>'
            if not isinstance(html, str) or not html.strip():
                raise SourceResponseError('Empty chapter returned by the source')
            body = html.encode('utf-8')
            check_storiesonline_notice(canonical, body)
            if len(body) > MAX_BODY:
                raise DownloadLimitError('Chapter exceeds the EPUB entry limit')
            body = zlib.compress(body, 3)
            references = []
            with db:
                for match in {m.group(): m for m in IMAGE.finditer(html)}.values():
                    image = adapter.story.img_store.get_img_by_uuid(match[1])
                    if not image:
                        continue  # A literal filename in the chapter need not be an embedded image.
                    if not image['data']:
                        raise SourceResponseError('Chapter illustration is incomplete')
                    image_hash = digest(image['data'])
                    db.execute('INSERT INTO images VALUES (?,?) ON CONFLICT(checksum) DO UPDATE SET data=excluded.data WHERE data != excluded.data', (image_hash, image['data']))
                    references.append((match.group(), image_hash, image['ext'], image['mime']))
                manifest = json.dumps(references)
                db.execute('INSERT OR REPLACE INTO chapters VALUES (?,?,?,?,?)', (*key, body, digest(body + manifest.encode()), manifest))
            downloaded += 1
            return html

        adapter.getChapterTextNum = chapter
        try:
            yield lambda: downloaded
        finally:
            adapter.getChapterTextNum = original
