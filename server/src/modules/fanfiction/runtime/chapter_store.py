"""Atomic recovery of completed FanFicFare chapters and the illustrations they use."""
import json
import re
import time
import zlib
from contextlib import closing, contextmanager

from chapter_checkpoint import ChapterCheckpoint, MAX_BODY, digest
from controlled_config import check_storiesonline_notice, StoriesOnlinePreview
from safe_transport import DownloadLimitError, SourceResponseError

# FanFicFare uses a URL-derived UUID for inline illustrations and CSS assets.
IMAGE = re.compile(r'images/ffdl-([0-9a-fA-F-]+)\.([a-zA-Z0-9]+)')


class ChapterDownloadYield(Exception):
    pass


@contextmanager
def recover_chapters(adapter, directory, canonical, transport):
    if not directory:
        yield None
        return
    with closing(ChapterCheckpoint(directory)) as store:
        downloaded = 0
        checkpointed = 0
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
            nonlocal downloaded, checkpointed
            # Yield only after durable new progress, with headroom before the
            # runtime's 600-second CPU cap. The next worker reuses these chapters.
            if checkpointed and time.process_time() >= 480:
                transport.failure = ChapterDownloadYield()
                raise transport.failure
            identity = adapter.normalize_chapterurl(url)
            if index in duplicates:
                identity += '\0' + str(duplicates[index])
            key = (story_key, digest(identity.encode()))
            row = store.load(key)
            if row:
                body, references, legacy = row
                try:
                    decoder = zlib.decompressobj()
                    stored = decoder.decompress(body, MAX_BODY + 1)
                    if len(stored) > MAX_BODY or not decoder.eof:
                        raise ValueError('Invalid saved chapter body')
                    references = json.loads(references)
                    try:
                        check_storiesonline_notice(canonical, stored)
                    except StoriesOnlinePreview:
                        pass  # Legacy previews must be fetched again.
                    else:
                        replacements = {}
                        for name, image_hash, ext, mime in references:
                            image = store.image(image_hash)
                            if image is None:
                                break
                            restored = adapter.story.img_store.add_img(name, ext, mime, image)
                            replacements[name] = restored['newsrc']
                        else:
                            if legacy:
                                store.save(key, body, json.dumps(references))
                            return IMAGE.sub(lambda match: replacements.get(match.group(), match.group()), stored.decode('utf-8'))
                except (ValueError, TypeError, UnicodeError, zlib.error):
                    pass  # A damaged chapter is repaired without discarding other progress.
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
            for match in {m.group(): m for m in IMAGE.finditer(html)}.values():
                image = adapter.story.img_store.get_img_by_uuid(match[1])
                if not image:
                    continue  # A literal filename in the chapter need not be an embedded image.
                if not image['data']:
                    raise SourceResponseError('Chapter illustration is incomplete')
                if len(image['data']) > MAX_BODY:
                    raise DownloadLimitError('Chapter illustration exceeds the EPUB entry limit')
                image_hash = store.put_image(image['data'])
                references.append((match.group(), image_hash, image['ext'], image['mime']))
            store.save(key, body, json.dumps(references))
            checkpointed += 1
            downloaded += 1
            return html

        adapter.getChapterTextNum = chapter
        try:
            yield lambda: downloaded
        finally:
            adapter.getChapterTextNum = original
