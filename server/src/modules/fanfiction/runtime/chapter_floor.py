"""Keep published chapters out of an updating web continuation.

An OPF marker stores a story URL, minimum chapter numbers, and explicitly
retained unnumbered bonus chapter URLs. ScribbleHub uses independent main
and side chapter cutoffs; Royal Road uses a chapter number or arc/chapter pair. Unnumbered
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
    site = (parts.hostname or '').removeprefix('www.')
    pattern = {'royalroad.com': r'^/fiction/(\d+)(?:/|$)',
               'scribblehub.com': r'^/(?:series|read)/(\d+)(?:[-/]|$)'}.get(site)
    match = re.match(pattern, parts.path) if pattern else None
    if (parts.scheme not in ('http', 'https') or parts.username or parts.password or parts.port or not match):
        raise PolicyError('The continuation cutoff belongs to a different story', code='source_continuation_invalid')
    return site, match[1]


def chapter_id(url):
    parts = urlsplit(url)
    match = re.search(r'/chapter/(\d+)(?:/|$)', parts.path)
    site, _ = story_id(url)
    if not match:
        raise PolicyError('The continuation contains an invalid bonus chapter URL', code='source_continuation_invalid')
    return site, match[1]


def validate_policy(policy):
    if (not isinstance(policy, dict) or set(policy) != {'version', 'storyUrl', 'minimum', 'extraChapterUrls'} or
            type(policy['version']) is not int or policy['version'] != 1):
        raise PolicyError('The continuation cutoff is invalid', code='source_continuation_invalid')
    if not isinstance(policy['storyUrl'], str):
        raise PolicyError('The continuation cutoff is invalid', code='source_continuation_invalid')
    site, _ = story_id(policy['storyUrl'])
    minimum = policy['minimum']
    if (not isinstance(minimum, list) or len(minimum) not in (1, 2) or
            any(type(n) is not int or not 0 <= n <= 999999 for n in minimum)):
        raise PolicyError('The continuation chapter number is invalid', code='source_continuation_invalid')
    # ScribbleHub uses independent main and side-story numbering, rather than arcs.
    if site == 'scribblehub.com' and len(minimum) != 2:
        raise PolicyError('A ScribbleHub continuation needs main and side chapter cutoffs', code='source_continuation_invalid')
    extras = policy['extraChapterUrls']
    if not isinstance(extras, list) or len(extras) > 100 or any(not isinstance(u, str) or len(u) > 2048 for u in extras):
        raise PolicyError('The continuation bonus chapter list is invalid', code='source_continuation_invalid')
    for url in extras:
        chapter_id(url)
        if story_id(url) != story_id(policy['storyUrl']):
            raise PolicyError('A continuation bonus chapter belongs to a different story', code='source_continuation_invalid')
    return policy


NUMBER_WORDS = dict(zip(
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety'.split(),
    list(range(20)) + list(range(20, 100, 10))))


def spelled_number(text):
    """Read the number at the beginning of a source chapter title."""
    tokens = re.findall(r'[a-z]+|[^\s-]', text.strip().lower())
    total = current = 0
    count = 0
    for token in tokens:
        if token in NUMBER_WORDS:
            current += NUMBER_WORDS[token]
        elif token == 'hundred' and current:
            current *= 100
        elif token == 'thousand' and current:
            total += current * 1000
            current = 0
        elif token == 'and' and count:
            continue
        else:
            break
        count += 1
    return total + current if count else None


def scribblehub_number(title):
    title = re.sub(r'^\s*Chapter\s+', '', title, flags=re.I).strip()
    side = bool(re.match(r'^Side\s+', title, re.I))
    if side:
        title = re.sub(r'^Side\s+', '', title, flags=re.I)
    numeric = re.match(r'^(\d+)(?=\s|[-:.]|$)', title)
    number = int(numeric[1]) if numeric else spelled_number(title)
    return (1 if side else 0), number


def read_policy(path):
    validate_epub(path, LIBRARY_EPUB_LIMIT)
    with ZipFile(path) as archive:
        _, doc = package(archive)
        markers = [n for n in doc.getElementsByTagNameNS(OPF, 'meta') if n.getAttribute('name') == MARKER]
        if not markers:
            return None
        if len(markers) != 1 or len(markers[0].getAttribute('content')) > 16384:
            raise PolicyError('The continuation cutoff is invalid', code='source_continuation_invalid')
        try:
            return validate_policy(json.loads(markers[0].getAttribute('content')))
        except (ValueError, TypeError, KeyError) as error:
            raise PolicyError('The continuation cutoff is invalid', code='source_continuation_invalid') from error


def apply_policy(adapter, policy, canonical_url):
    if policy is None:
        return
    if story_id(canonical_url) != story_id(policy['storyUrl']):
        raise PolicyError('The continuation cutoff belongs to a different story', code='source_continuation_invalid')
    site, _ = story_id(canonical_url)
    minimum = tuple(policy['minimum'])
    pattern = (r'^\s*(?:Chapter\s+)?(\d+)\s*[-–]\s*(\d+)(?=\s|[:.]|$)' if len(minimum) == 2 else
               r'^\s*(?:Chapter\s+)?(\d+)(?=\s|[-:.]|$)')
    extras = {chapter_id(url) for url in policy['extraChapterUrls']}
    selected = []
    for chapter in adapter.get_chapters():
        title = chapter.get('site_title', chapter['title'])
        match = re.match(pattern, title, re.I)
        if site == 'scribblehub.com':
            kind, number = scribblehub_number(title)
            include = number >= minimum[kind] if number is not None else chapter_id(chapter['url']) in extras
        elif match:
            include = tuple(int(n) for n in match.groups()) >= minimum
        else:
            include = bool(extras) and chapter_id(chapter['url']) in extras
        if include:
            selected.append(chapter)
    if not selected:
        raise PolicyError('No chapters are available after this continuation cutoff', code='source_continuation_empty')
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
        raise PolicyError('The updated book does not match its continuation cutoff', code='source_continuation_invalid')
