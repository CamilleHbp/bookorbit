"""Keep published chapters out of an updating web continuation.

An OPF marker stores a story URL, a minimum chapter number (or arc/chapter
pair), and explicitly retained unnumbered bonus chapter URLs. Unnumbered
announcements are excluded. Invalid policies fail closed during updates.
"""
import json
import os
import re
import tempfile
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile

from epub_policy import LIBRARY_EPUB_LIMIT, validate_epub
from publisher_edition import package, OPF, DC
from safe_transport import PolicyError
from chapter_locks import chapters

MARKER = 'bookorbit:chapter-floor'


def story_id(url):
    parts = urlsplit(url)
    match = re.match(r'^/fiction/(\d+)(?:/|$)', parts.path)
    if (parts.scheme not in ('http', 'https') or parts.hostname not in ('www.royalroad.com', 'royalroad.com') or
            parts.username or parts.password or parts.port or not match):
        raise PolicyError('The continuation cutoff belongs to a different story')
    return match[1]


def chapter_id(url):
    parts = urlsplit(url)
    match = re.search(r'/chapter/(\d+)(?:/|$)', parts.path)
    if parts.hostname not in ('www.royalroad.com', 'royalroad.com') or not match:
        raise PolicyError('The continuation contains an invalid bonus chapter URL')
    return match[1]


def validate_policy(policy):
    if (not isinstance(policy, dict) or set(policy) != {'version', 'storyUrl', 'minimum', 'extraChapterUrls'} or
            type(policy['version']) is not int or policy['version'] != 1):
        raise PolicyError('The continuation cutoff is invalid')
    if not isinstance(policy['storyUrl'], str):
        raise PolicyError('The continuation cutoff is invalid')
    story_id(policy['storyUrl'])
    minimum = policy['minimum']
    if (not isinstance(minimum, list) or len(minimum) not in (1, 2) or
            any(type(n) is not int or not 0 <= n <= 999999 for n in minimum)):
        raise PolicyError('The continuation chapter number is invalid')
    extras = policy['extraChapterUrls']
    if not isinstance(extras, list) or len(extras) > 100 or any(not isinstance(u, str) or len(u) > 2048 for u in extras):
        raise PolicyError('The continuation bonus chapter list is invalid')
    for url in extras:
        chapter_id(url)
        if story_id(url) != story_id(policy['storyUrl']):
            raise PolicyError('A continuation bonus chapter belongs to a different story')
    return policy


def read_policy(path):
    validate_epub(path, LIBRARY_EPUB_LIMIT)
    with ZipFile(path) as archive:
        _, doc = package(archive)
        markers = [n for n in doc.getElementsByTagNameNS(OPF, 'meta') if n.getAttribute('name') == MARKER]
        if not markers:
            return None
        if len(markers) != 1 or len(markers[0].getAttribute('content')) > 16384:
            raise PolicyError('The continuation cutoff is invalid')
        try:
            return validate_policy(json.loads(markers[0].getAttribute('content')))
        except (ValueError, TypeError, KeyError) as error:
            raise PolicyError('The continuation cutoff is invalid') from error


def apply_policy(adapter, policy, canonical_url):
    if policy is None:
        return
    if story_id(canonical_url) != story_id(policy['storyUrl']):
        raise PolicyError('The continuation cutoff belongs to a different story')
    minimum = tuple(policy['minimum'])
    pattern = (r'^\s*(?:Chapter\s+)?(\d+)\s*[-–]\s*(\d+)(?=\s|[:.]|$)' if len(minimum) == 2 else
               r'^\s*(?:Chapter\s+)?(\d+)(?=\s|[-:.]|$)')
    extras = {chapter_id(url) for url in policy['extraChapterUrls']}
    selected = []
    for chapter in adapter.get_chapters():
        match = re.match(pattern, chapter.get('site_title', chapter['title']), re.I)
        if match:
            include = tuple(int(n) for n in match.groups()) >= minimum
        else:
            include = bool(extras) and chapter_id(chapter['url']) in extras
        if include:
            selected.append(chapter)
    if not selected:
        raise PolicyError('No chapters are available after this continuation cutoff')
    adapter.chapterInfos = selected
    adapter.story.setMetadata('numChapters', len(selected))


def preserve_policy(previous, output, policy):
    if policy is None:
        return
    temporary = None
    try:
        with ZipFile(previous) as old, ZipFile(output) as new:
            _, saved = package(old)
            path, fresh = package(new)
            metadata = fresh.getElementsByTagNameNS(OPF, 'metadata')[0]
            # Keep the continuation's reader-facing identity as well as its cutoff.
            names = {MARKER, 'calibre:series', 'calibre:series_index'}
            for node in list(metadata.childNodes):
                if node.nodeType == node.ELEMENT_NODE and (node.namespaceURI == DC and node.localName == 'title' or
                        node.localName == 'meta' and node.getAttribute('name') in names):
                    metadata.removeChild(node)
            for node in saved.getElementsByTagNameNS(OPF, 'metadata')[0].childNodes:
                if node.nodeType == node.ELEMENT_NODE and (node.namespaceURI == DC and node.localName == 'title' or
                        node.localName == 'meta' and node.getAttribute('name') in names):
                    metadata.appendChild(fresh.importNode(node, True))
            with tempfile.NamedTemporaryFile(dir=Path(output).parent, suffix='.epub', delete=False) as file:
                temporary = file.name
            with ZipFile(temporary, 'w') as archive:
                for entry in new.infolist():
                    archive.writestr(entry, fresh.toxml(encoding='utf-8') if entry.filename == path else new.read(entry.filename))
        validate_epub(temporary, LIBRARY_EPUB_LIMIT)
        with open(temporary, 'rb') as file:
            os.fsync(file.fileno())
        os.replace(temporary, output)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def validate_output(output, selected):
    with ZipFile(output) as archive:
        _, _, written = chapters(archive)
    expected = Counter(chapter_id(c['url']) for c in selected)
    actual = Counter(chapter_id(url) for url, _ in written)
    if expected != actual:
        raise PolicyError('The updated book does not match its continuation cutoff')
