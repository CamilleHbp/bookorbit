import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

if __name__ == '__main__':
    from worker_parent import bind_to_parent
    bind_to_parent()

from story_spool import StorySpool
from chapter_store import ChapterDownloadYield, recover_chapters
from chapter_locks import chapters as indexed_chapters, preserve_chapter_locks
from chapter_floor import read_policy, apply_policy, preserve_policy, validate_output
from update_check import UpdateCheck
import publisher_edition
from tag_matching import install as install_tag_matching, matched_preview


import importlib.metadata
import json
import logging
import os
import re
import resource
import socket
import ssl
import sqlite3
from contextlib import nullcontext
from functools import partial
import tempfile
import time
import traceback
import unicodedata
from urllib.parse import unquote, urlsplit
from zipfile import BadZipFile, ZipFile
from xml.parsers.expat import ExpatError, ParserCreate
from collections import Counter

from website_catalog import website_catalog
from controlled_config import check_storiesonline_notice, make_configuration, merge_configuration, StoriesOnlinePreview, validate_ini
from epub_policy import LIBRARY_EPUB_LIMIT, NEW_EPUB_LIMIT, validate_epub
from image_processing import install_image_processing
from safe_transport import ConfigurationError, PolicyError, ResponseLimitError, SafeTransport, install_network_guard, validate_url
from fanfiction_net_login import login_fanfiction_net
from scribblehub_login import login_scribblehub
from flaresolverr_transport import FlareSolverrTransport

VERSION = '4.63.0'
TEST_SITES = {'test1.com', 'test2.com'}
AO3_ALIASES = {'archive.transformativeworks.org', 'insecure.archiveofourown.org', 'secure.ao3.org'}
ROYAL_ROAD_HOSTS = {'www.royalroad.com', 'royalroad.com', 'www.royalroadl.com', 'royalroadl.com'}


class RecognitionNeedsAccess(Exception):
    pass


class RecognitionTransport(SafeTransport):
    def request(self, method, url, parameters=None, headers=None):
        raise RecognitionNeedsAccess()


def install_bounded_otw_chapters(adapter):
    from fanficfare.adapters.base_otw_adapter import BaseOTWAdapter
    if not isinstance(adapter, BaseOTWAdapter) or getattr(adapter, '_bookorbit_bounded_otw', False):
        return
    original = adapter.getChapterTextNum

    def chapter(url, index):
        try:
            return original(url, index)
        except ResponseLimitError:
            if not adapter.use_full_work_soup or not adapter.getConfig('use_view_full_work', True):
                raise
            # Keep efficient whole-work reads for small stories and retry oversized
            # works by chapter without relaxing the transport's response budget.
            adapter.use_full_work_soup = False
            adapter.full_work_soup = None
            adapter.full_work_chapters = None
            logging.getLogger(__name__).warning('[fanfiction.chapter_fetch] [fail] errorClass=ResponseLimitError fallback=chapter - whole-work response exceeded its budget')
            return original(url, index)

    adapter.getChapterTextNum = chapter
    adapter._bookorbit_bounded_otw = True


def normalize_ao3_url(url):
    parsed = urlsplit(url)
    if parsed.hostname in AO3_ALIASES:
        return parsed._replace(netloc='archiveofourown.org').geturl()
    return url


def story_adapter(configuration, url):
    from fanficfare import adapters, exceptions
    try:
        return adapters.getAdapter(configuration, url)
    except exceptions.InvalidStoryURL:
        # Some legacy adapters accept only http in their URL grammar.
        # The fetcher still enforces HTTPS for every network request.
        return adapters.getAdapter(configuration, url.replace('https://', 'http://', 1))


def fictionlive_story_url(adapter, title):
    title = unicodedata.normalize('NFKD', title)
    title = ''.join(c for c in title if not unicodedata.combining(c))
    slug = re.sub(r'[^a-zA-Z0-9]+', '-', title).strip('-')[:150].rstrip('-')
    return f'https://fiction.live/stories/{slug or "Story"}/{adapter.story_id}'


def royal_road_story_url(canonical, candidates):
    for value in candidates:
        parsed = urlsplit(value)
        if parsed.hostname not in ROYAL_ROAD_HOSTS:
            continue
        match = re.match(r'^(/fiction/[0-9]+)/([a-zA-Z0-9-]+)(?:/|$)', parsed.path)
        if match and canonical.endswith(match[1]) and match[2] != 'chapter':
            return f'{canonical}/{match[2]}'
    return canonical


def recognize_urls(urls):
    from fanficfare import exceptions
    if not isinstance(urls, list) or not 0 < len(urls) <= 100:
        raise PolicyError('URL recognition batch exceeds its limit', code='source_input_invalid')
    result = []
    for url in urls:
        if not isinstance(url, str) or len(url) > 4096:
            raise PolicyError('Invalid URL recognition input', code='source_url_invalid')
        try:
            validate_url(url)
            if url in publisher_edition.EDITIONS:
                result.append({'url': url, 'recognized': True, 'canonicalUrl': url, 'site': publisher_edition.SITE})
                continue
            adapter_url = normalize_ao3_url(url)
            adapter = story_adapter(make_configuration(adapter_url, '', RecognitionTransport()), adapter_url)
            canonical = adapter.url.replace('http://', 'https://', 1)
            site = adapter.getSiteDomain()
            if site == 'fiction.live':
                # The adapter strips the title segment to identify stories by ID.
                canonical = fictionlive_story_url(adapter, unquote(urlsplit(url).path.split('/')[2]))
            elif site == 'www.royalroad.com':
                canonical = royal_road_story_url(canonical, [url])
            validate_url(canonical)
            if site.removeprefix('www.') in TEST_SITES:
                result.append({'url': url, 'recognized': False, 'reason': 'unsupported'})
            else:
                entry = {'url': url, 'recognized': True, 'canonicalUrl': canonical, 'site': site}
                identity = story_identity(adapter)
                if identity != canonical:
                    entry['identityUrl'] = identity
                result.append(entry)
        except (exceptions.UnknownSite, exceptions.InvalidStoryURL):
            result.append({'url': url, 'recognized': False, 'reason': 'unsupported'})
        except RecognitionNeedsAccess:
            result.append({'url': url, 'recognized': False, 'reason': 'access_required'})
        except PolicyError:
            result.append({'url': url, 'recognized': False, 'reason': 'unsafe'})
    return result


def limits(operation):
    resource.setrlimit(resource.RLIMIT_CPU, (600, 600))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    if operation not in ('download', 'update', 'refresh'):
        resource.setrlimit(resource.RLIMIT_FSIZE, (NEW_EPUB_LIMIT, NEW_EPUB_LIMIT))
        if sys.platform == 'linux':
            resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))


def metadata_count(story, key, maximum):
    value = story.getMetadataRaw(key)
    if isinstance(value, bool):
        return None
    text = str(value).strip()
    if len(text) > 32 or not text.isascii() or not text.isdecimal():
        return None
    number = int(text)
    return number if 0 <= number <= maximum else None


def omit_empty_fictionlive_home(adapter):
    if adapter.getSiteDomain() != 'fiction.live':
        return None
    home = adapter.chapter_id_to_api.get('home')
    chapters = adapter.get_chapters()
    if not home or not chapters or chapters[0]['url'] != home:
        return None
    # The adapter synthesizes Home for the time before the first bookmark.
    # That range can hold real story chunks, including illustrations without text.
    chunks = json.loads(adapter.get_request(home))
    # FictionLiveAdapter renders #special entries as separate appendix chapters.
    if isinstance(chunks, list) and all(str(chunk.get('t', '')).startswith('#special') for chunk in chunks):
        adapter.del_chapter(0)
        return home
    return None


def empty_saved_home_url(adapter, saved):
    if adapter.getSiteDomain() == 'fiction.live' and saved:
        home = adapter.chapter_id_to_api.get('home')
        body = saved.get(home)
        if isinstance(body, partial):
            body = body()
        if body is not None and not body.get_text(strip=True) and all(
                tag.name in ('html', 'body', 'div', 'br') for tag in body.find_all(True)):
            return home
    return None


def installed_chapter_map(adapter, saved):
    # FanFicFare falls back to chapter position when its URL map is empty.
    # Only uniquely identified, valid bodies are safe after a source reorder.
    def normalize(url):
        return adapter.normalize_chapterurl(url).replace('http://', 'https://', 1)

    current = Counter(normalize(c['url']) for c in adapter.get_chapters())
    with ZipFile('input.epub') as archive:
        _, _, entries = indexed_chapters(archive, metadata_only=True)
        counts = Counter(normalize(url) for url, _ in entries)
        eligible = {}
        for (url, _), (path, _, locked) in entries.items():
            key = normalize(url)
            if counts[key] != 1 or current[key] != 1:
                continue
            try:
                ParserCreate().Parse(archive.read(path), True)
            except ExpatError:
                continue
            eligible[key] = (url, locked)
    reusable = {}
    retained_locks = set()
    for url, body in saved.items():
        key = normalize(url)
        if key not in eligible:
            continue
        identity, locked = eligible[key]
        if locked:
            # The final EPUB pass copies the protected body and its resources.
            reusable[url] = adapter.make_soup('<body><p> </p></body>').body
            retained_locks.add((identity, 0))
            continue
        reference = body
        if adapter.getSiteDomain() in ('fiction.live', 'storiesonline.net') and isinstance(body, partial):
            body = body()
        if adapter.getSiteDomain() == 'fiction.live' and not body.get_text(strip=True) and not body.find(['img', 'svg', 'video', 'audio']):
            continue
        if adapter.getSiteDomain() == 'storiesonline.net':
            try:
                check_storiesonline_notice(url, body.encode())
            except StoriesOnlinePreview:
                continue
        reusable[url] = reference
    return reusable, retained_locks


def story_identity(adapter):
    # FanFicFare provides section URLs specifically for story URLs that can change.
    url = adapter.get_section_url(adapter.url).replace('http://', 'https://', 1)
    from fanficfare.adapters.adapter_storiesonlinenet import StoriesOnlineNetAdapter
    if isinstance(adapter, StoriesOnlineNetAdapter):
        match = re.fullmatch(r'(https://[^/]+/[sn]/[0-9]+)(?:/[^/?#]+)?/?', url)
        if match:
            return match.group(1)
    return url


def story_preview(adapter, story, url):
    canonical = story.getMetadata('storyUrl').replace('http://', 'https://', 1)
    if adapter.getSiteDomain() == 'fiction.live':
        canonical = fictionlive_story_url(adapter, story.getMetadata('title') or '')
    elif adapter.getSiteDomain() == 'www.royalroad.com':
        canonical = royal_road_story_url(story_identity(adapter), [chapter['url'] for chapter in adapter.get_chapters()] + [url])
    validate_url(canonical)
    chapter_count = metadata_count(story, 'numChapters', 10_000)
    if not chapter_count:
        raise PolicyError('Chapter count limit exceeded', code='source_chapter_limit')
    return {
        'canonicalUrl': canonical,
        'site': adapter.getConfigSection(), 'title': story.getMetadata('title'),
        'authors': story.getList('author'), 'description': story.getMetadata('description') or '',
        'chapterCount': chapter_count, 'wordCount': metadata_count(story, 'numWords', 2_147_483_647),
        'status': story.getMetadata('status') or '', 'tags': story.getSubjectTags(),
        'genres': story.getList('genre'),
        'categories': {
            'fandoms': story.getList('category'), 'relationships': story.getList('ships'),
            'characters': story.getList('characters'), 'warnings': story.getList('warnings'),
            'rating': story.getMetadata('rating') or '',
        },
    }


class ProgressReporter:
    def __init__(self, emit):
        self.sink = emit
        self.last_sent = 0
        self.total = 0
        self.downloaded = None
        self.state = {'stage': 'metadata'}

    def emit(self, value):
        if value.get('stage') != self.state['stage']:
            self.state = {'stage': value['stage']}
        self.state.update(value)
        self.last_sent = time.monotonic()
        self.sink(dict(self.state))

    def activity(self, activity, chapter=None, title=None):
        self.state['activity'] = activity
        if chapter is not None:
            if self.state.get('currentChapter') != chapter:
                self.state.pop('illustration', None)
            self.state['currentChapter'] = chapter
            if title is not None:
                self.state['currentChapterTitle'] = title
        if activity == 'illustrations':
            self.state['illustration'] = self.state.get('illustration', 0) + 1
        now = time.monotonic()
        if now - self.last_sent >= 1:
            self.last_sent = now
            self.sink(dict(self.state))

    def chapters(self, fraction, _url):
        completed = min(self.total, max(0, round(fraction * self.total)))
        counts = {'completedChapters': completed, 'totalChapters': self.total}
        if self.downloaded is not None:
            counts['reusedChapters'] = max(0, completed - self.downloaded())
        self.state.update(counts)
        if completed < self.total and time.monotonic() - self.last_sent < 1:
            return
        self.emit({'stage': 'downloading', **counts})
        if completed == self.total:
            self.emit({'stage': 'packaging', **counts})


def run(request, save_cookies=None, report_progress=lambda progress: None):
    actual = importlib.metadata.version('FanFicFare')
    if actual != VERSION or importlib.metadata.version('curl_cffi') != '0.17.0':
        raise PolicyError('Pinned FanFicFare runtime version does not match', code='runtime_unavailable')
    install_image_processing()
    from fanficfare import adapters, writers
    operation = request.get('operation')
    if operation == 'health':
        return {'version': actual, 'protocolVersion': 1, 'ready': True}
    if operation == 'sites':
        return {'version': actual, 'sites': website_catalog()}
    if operation == 'recognize':
        return recognize_urls(request.get('urls'))
    if operation == 'merge':
        return {'configuration': merge_configuration(request.get('previous', ''), request.get('configuration'), request.get('edits'), request.get('redact', False))}
    ini = validate_ini(request.get('configuration', ''))
    if operation == 'validate':
        return {'valid': True}
    url = request.get('url')
    validate_url(url)
    url = normalize_ao3_url(url)
    timeout = min(7200, max(1, request.get('timeoutSeconds', 1800)))
    if validate_url(url)[1].removeprefix('www.') == 'royalroad.com' and operation in ('download', 'update', 'refresh'):
        timeout = min(7200, max(1, request.get('browserTimeoutSeconds', timeout)))
    budgets = {'timeout': timeout}
    if operation in ('download', 'update', 'refresh'):
        # Per-response and request-count checks still bound each source operation.
        budgets['max_bytes'] = sys.maxsize
    transport = FlareSolverrTransport(request['flaresolverrUrl'], session_id=request.get('browserSession'), **budgets) if request.get('flaresolverrUrl') else SafeTransport(**budgets)
    transport.load_cookies(request.get('cookies', []))
    try:
        with (tempfile.TemporaryFile(dir='.') if operation in ('download', 'update', 'refresh') else nullcontext()) as spool:
            return run_story(request, transport, operation, url, ini, save_cookies, report_progress, StorySpool(spool) if spool else None)
    finally:
        transport.close()


def run_story(request, transport, operation, url, ini, save_cookies, report_progress, spool=None):
    from fanficfare import adapters, writers
    progress = ProgressReporter(report_progress)
    transport.report_activity = progress.activity
    def finish(result):
        if save_cookies is not None:
            save_cookies(transport.export_cookies())
        return result
    if url in publisher_edition.EDITIONS:
        result = publisher_edition.edition(request, transport)
        if operation in ('update', 'refresh') and result.get('output') == 'output.epub':
            preserve_chapter_locks('input.epub', 'output.epub')
        return finish(result)
    configuration = make_configuration(url, ini, transport)
    if configuration.getConfig('use_flaresolverr_proxy', False):
        if not isinstance(transport, FlareSolverrTransport):
            raise ConfigurationError('FlareSolverr is not configured on this server')
        transport.enable_for(url)
        transport.prefer_direct = configuration.getConfig('use_flaresolverr_proxy') == 'auto'
        transport.deadline = time.monotonic() + min(7200, max(1, request.get('browserTimeoutSeconds', request.get('timeoutSeconds', 1800))))
    if operation in ('download', 'update', 'refresh'):
        if not configuration.has_section('overrides'):
            configuration.add_section('overrides')
        for option in ('always_reload_first_chapter', 'continue_on_chapter_error'):
            configuration.set('overrides', option, 'false')
        configuration.set('overrides', 'update_check_recent_chapters', '0')
    adapter = story_adapter(configuration, url)
    progress.emit({'stage': 'metadata'})
    login_scribblehub(adapter, allow_public=operation in ('download', 'update', 'refresh'))
    # FanFicFare caches metadata, so the writer cannot fetch a skipped cover later.
    get_cover = operation in ('download', 'update', 'refresh')
    try:
        story = adapter.getStoryMetadataOnly(get_cover=get_cover)
    except Exception as error:
        if (adapter.getSiteDomain() != 'www.fanfiction.net' or
                failure_code(error) != 'authentication_required' or not adapter.getConfig('username', '')):
            raise
        login_fanfiction_net(adapter, transport)
        adapter = story_adapter(configuration, url)
        story = adapter.getStoryMetadataOnly(get_cover=get_cover)
    install_bounded_otw_chapters(adapter)
    empty_home = omit_empty_fictionlive_home(adapter)
    install_tag_matching(story, adapter.getConfigSection(), request.get('tagMatching') or {'version': 0, 'rules': []})
    preview = matched_preview(story, story_preview(adapter, story, url))
    canonical = preview['canonicalUrl']
    continuation = read_policy('input.epub') if operation in ('update', 'refresh') else None
    if continuation is not None:
        if not apply_policy(adapter, continuation, canonical, 'input.epub'):
            # The cutoff already verified the adapter identity. Keep the
            # registered URL for the unchanged-edition result.
            preview['canonicalUrl'] = url
            return finish({'preview': preview, 'output': 'input.epub', 'unchangedEdition': True})
        continuation_chapters = adapter.get_chapters()
        configuration.set('overrides', 'update_preserve_deleted_chapters', 'false')
        preview = matched_preview(story, story_preview(adapter, story, url))
    if spool:
        story.img_store.spool_info = spool.image_info
    chapter_count = preview['chapterCount']
    if operation == 'preview':
        return finish(preview)
    if operation not in ('download', 'update', 'refresh'):
        raise PolicyError('Unsupported integration operation', code='runtime_unavailable')
    separate_story_url = adapter.getSiteDomain() in ('fiction.live', 'www.royalroad.com')
    # Keep the existing internal URL for saved verification and download checkpoints.
    checkpoint_url = story_identity(adapter) if separate_story_url else canonical
    check = UpdateCheck(request, adapter, {**preview, 'canonicalUrl': checkpoint_url})
    if operation == 'update' and check.unchanged():
        progress.emit({'stage': 'validating', 'completedChapters': chapter_count, 'totalChapters': chapter_count})
        return finish({'preview': preview, 'output': 'input.epub'})
    retained_locks = set()
    if operation in ('update', 'refresh'):
        from fanficfare.epubutils import get_update_data
        validate_epub('input.epub', LIBRARY_EPUB_LIMIT)
        # Stock installations can still read EPUBs without the packaged streaming patch.
        options = {'spool': spool} if hasattr(story, 'iterChapters') and spool else {}
        old = get_update_data('input.epub', **options)
        previous_url, previous_count = old[:2]
        saved_url = (previous_url or '').replace('http://', 'https://', 1)
        if saved_url != canonical:
            previous, current = recognize_urls([saved_url, canonical])
            if (not previous.get('recognized') or not current.get('recognized') or previous['site'] != current['site'] or
                    previous.get('identityUrl', previous['canonicalUrl']) != current.get('identityUrl', current['canonicalUrl'])):
                return finish({'reviewRequired': 'identity_mismatch', 'preview': preview})
        saved_placeholder = empty_saved_home_url(adapter, old[7])
        if empty_home and empty_home == saved_placeholder:
            previous_count -= 1
        if previous_count > chapter_count and request.get('reviewChanges') is not True:
            return finish({'reviewRequired': 'chapter_reduction', 'preview': preview})
        if operation == 'update':
            (adapter.oldchapters, adapter.oldimgs, adapter.oldcover, adapter.calibrebookmark,
             adapter.logfile, adapter.oldchaptersmap, adapter.oldchaptersdata) = old[2:9]
            if request.get('checkStatePath'):
                adapter.oldchapters = None
                adapter.oldchaptersmap, retained_locks = installed_chapter_map(adapter, adapter.oldchaptersmap)
                configuration.set('overrides', 'update_preserve_deleted_chapters', 'false')
            if saved_placeholder:
                adapter.oldchaptersmap.pop(saved_placeholder, None)
                if not adapter.oldchaptersmap:
                    adapter.oldchapters = None
        del old
        import gc
        gc.collect()
    with open('output.epub', 'xb') as output:
        story.chapter_spool = spool.file if spool else None
        progress.total = chapter_count
        progress.emit({'stage': 'downloading', 'completedChapters': 0, 'totalChapters': chapter_count})
        if separate_story_url:
            story.setMetadata('storyUrl', canonical)
        with recover_chapters(adapter, check.chapter_directory(request.get('chapterDirectory')), checkpoint_url, transport) as downloaded:
            progress.downloaded = downloaded
            writers.getWriter('epub', configuration, adapter).writeStory(outstream=output, notification=progress.chapters)
        if transport.failure is not None:
            raise transport.failure
        output.flush()
        os.fsync(output.fileno())
    progress.emit({'stage': 'validating', 'completedChapters': chapter_count, 'totalChapters': chapter_count})
    validate_epub('output.epub', LIBRARY_EPUB_LIMIT if operation in ('update', 'refresh') else NEW_EPUB_LIMIT)
    if operation in ('update', 'refresh'):
        preserve_chapter_locks('input.epub', 'output.epub', retained_locks)
        preserve_policy('input.epub', 'output.epub', continuation)
        if continuation is not None:
            validate_output('output.epub', continuation_chapters)
    check.save('output.epub')
    return finish({'preview': matched_preview(adapter.story, story_preview(adapter, adapter.story, url)), 'output': 'output.epub'})


def execute_request(request, report_progress=lambda progress: None):
    cookies = []
    result = run(request, cookies.extend, report_progress)
    return {'ok': True, 'result': result, 'cookies': cookies}


def http_error_status(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        status = getattr(error, 'status_code', None)
        if type(status) is int and 400 <= status <= 599:
            return status
        error = error.__cause__ or error.__context__
    return None


def failure_code(error):
    if isinstance(error, ChapterDownloadYield):
        return 'chapter_download_yielded'
    name = type(error).__name__
    status = http_error_status(error)
    if name == 'AdultCheckRequired':
        return 'adult_confirmation_required'
    if name == 'AccessDenied' or status == 403:
        return 'access_denied'
    if name == 'FailedToLogin' or status == 401:
        return 'authentication_required'
    if name == 'PersonalIniFailed':
        return 'configuration_blocked'
    if isinstance(error, (BadZipFile, ExpatError)):
        return 'invalid_epub'
    if name in ('InvalidStoryURL', 'UnknownSite'):
        return 'unsupported_story_url'
    if isinstance(error, sqlite3.Error) and getattr(error, 'sqlite_errorcode', None) in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB):
        return 'chapter_storage_damaged'
    from chapter_checkpoint import CheckpointStorageError
    if isinstance(error, OSError) and error.errno == 28:
        return 'download_storage_low'
    if isinstance(error, (sqlite3.Error, CheckpointStorageError)) or isinstance(error, OSError) and error.errno == 30:
        return 'chapter_storage_failed'
    if isinstance(error, PolicyError):
        return error.code
    if isinstance(error, MemoryError):
        return 'download_memory_limit'
    if isinstance(error, TimeoutError):
        return 'download_timeout'
    if isinstance(error, socket.gaierror):
        return 'source_dns_failed'
    if isinstance(error, ssl.SSLCertVerificationError):
        return 'source_certificate_invalid'
    if isinstance(error, ConnectionError):
        return 'source_connection_failed'
    if status == 429:
        return 'source_rate_limited'
    if status is not None and status >= 500:
        return 'source_unavailable'
    if name == 'StoryDoesNotExist' or status in (404, 410):
        return 'source_not_found'
    if name == 'FailedToDownload' and 'this work is part of an ongoing challenge and will be revealed soon!' in str(error).casefold():
        return 'source_unrevealed'
    return 'source_failed'


def main():
    logging.disable(logging.CRITICAL)
    install_network_guard()
    try:
        raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise PolicyError('Input limit exceeded', code='source_input_invalid')
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise PolicyError('Invalid integration request', code='source_input_invalid')
        limits(request.get('operation'))
        def report_progress(progress):
            sys.stderr.write('BOOKORBIT_PROGRESS ' + json.dumps(progress) + '\n')
            sys.stderr.flush()
        result = execute_request(request, report_progress)
    except Exception as error:
        name = type(error).__name__
        code = failure_code(error)
        frames = traceback.extract_tb(error.__traceback__)
        location = f'{Path(frames[-1].filename).name}:{frames[-1].lineno}:{frames[-1].name}' if frames else ''
        # Exception messages can contain credentials, source content or private URLs.
        result = {'ok': False, 'code': code, 'errorClass': name, 'errorLocation': location, 'httpStatus': http_error_status(error)}
    encoded = json.dumps(result, ensure_ascii=True)
    if len(encoded) > 1024 * 1024:
        encoded = '{"ok":false,"code":"output_limit","errorClass":"PolicyError"}'
    sys.stdout.write(encoded)


if __name__ == '__main__':
    main()
