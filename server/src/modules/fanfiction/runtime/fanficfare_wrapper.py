import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chapter_store import ChapterDownloadYield, recover_chapters
from chapter_locks import preserve_chapter_locks
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
import sqlite3
import time
import traceback
from zipfile import BadZipFile
from xml.parsers.expat import ExpatError

from website_catalog import website_catalog
from controlled_config import make_configuration, merge_configuration, validate_ini
from epub_policy import LIBRARY_EPUB_LIMIT, NEW_EPUB_LIMIT, validate_epub
from image_processing import install_image_processing
from safe_transport import ConfigurationError, PolicyError, ResponseLimitError, SafeTransport, install_network_guard, validate_url
from fanfiction_net_login import login_fanfiction_net
from scribblehub_login import login_scribblehub
from flaresolverr_transport import FlareSolverrTransport

VERSION = '4.63.0'
TEST_SITES = {'test1.com', 'test2.com'}


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


def story_adapter(configuration, url):
    from fanficfare import adapters, exceptions
    try:
        return adapters.getAdapter(configuration, url)
    except exceptions.InvalidStoryURL:
        # Some legacy adapters accept only http in their URL grammar.
        # The fetcher still enforces HTTPS for every network request.
        return adapters.getAdapter(configuration, url.replace('https://', 'http://', 1))


def recognize_urls(urls):
    from fanficfare import exceptions
    if not isinstance(urls, list) or not 0 < len(urls) <= 100:
        raise PolicyError('URL recognition batch exceeds its limit')
    result = []
    for url in urls:
        if not isinstance(url, str) or len(url) > 4096:
            raise PolicyError('Invalid URL recognition input')
        try:
            validate_url(url)
            if url in publisher_edition.EDITIONS:
                result.append({'url': url, 'recognized': True, 'canonicalUrl': url, 'site': publisher_edition.SITE})
                continue
            adapter = story_adapter(make_configuration(url, '', RecognitionTransport()), url)
            canonical = adapter.url.replace('http://', 'https://', 1)
            validate_url(canonical)
            site = adapter.getSiteDomain()
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
    size_limit = LIBRARY_EPUB_LIMIT if operation in ('update', 'refresh') else NEW_EPUB_LIMIT
    resource.setrlimit(resource.RLIMIT_FSIZE, (size_limit, size_limit))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
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
        if body is not None and not body.get_text(strip=True) and all(
                tag.name in ('html', 'body', 'div', 'br') for tag in body.find_all(True)):
            return home
    return None


def story_identity(adapter):
    # FanFicFare provides section URLs specifically for story URLs that can change.
    url = adapter.get_section_url(adapter.url).replace('http://', 'https://', 1)
    from fanficfare.adapters.adapter_storiesonlinenet import StoriesOnlineNetAdapter
    if isinstance(adapter, StoriesOnlineNetAdapter):
        match = re.fullmatch(r'(https://[^/]+/[sn]/[0-9]+)(?:/[^/?#]+)?/?', url)
        if match:
            return match.group(1)
    return url


def story_preview(adapter, story):
    canonical = story.getMetadata('storyUrl').replace('http://', 'https://', 1)
    validate_url(canonical)
    chapter_count = metadata_count(story, 'numChapters', 10_000)
    if not chapter_count:
        raise PolicyError('Chapter count limit exceeded')
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
        raise PolicyError('Pinned FanFicFare runtime version does not match')
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
    timeout = min(7200, max(1, request.get('timeoutSeconds', 1800)))
    if validate_url(url)[1].removeprefix('www.') == 'royalroad.com' and operation in ('download', 'update', 'refresh'):
        timeout = min(7200, max(1, request.get('browserTimeoutSeconds', timeout)))
    transport = FlareSolverrTransport(request['flaresolverrUrl'], session_id=request.get('browserSession'), timeout=timeout) if request.get('flaresolverrUrl') else SafeTransport(timeout=timeout)
    transport.load_cookies(request.get('cookies', []))
    try:
        return run_story(request, transport, operation, url, ini, save_cookies, report_progress)
    finally:
        transport.close()


def run_story(request, transport, operation, url, ini, save_cookies, report_progress):
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
        transport.deadline = time.monotonic() + min(7200, max(1, request.get('browserTimeoutSeconds', request.get('timeoutSeconds', 1800))))
    # Unscoped updates retain FanFicFare's append-only behavior. Managed checks
    # periodically verify saved text even when the website reports no changes.
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
    preview = matched_preview(story, story_preview(adapter, story))
    canonical = preview['canonicalUrl']
    continuation = read_policy('input.epub') if operation in ('update', 'refresh') else None
    if continuation is not None:
        apply_policy(adapter, continuation, canonical)
        continuation_chapters = adapter.get_chapters()
        configuration.set('overrides', 'update_preserve_deleted_chapters', 'false')
        preview = matched_preview(story, story_preview(adapter, story))
    chapter_count = preview['chapterCount']
    if operation == 'preview':
        return finish(preview)
    if operation not in ('download', 'update', 'refresh'):
        raise PolicyError('Unsupported integration operation')
    check = UpdateCheck(request, adapter, preview)
    if operation == 'update' and check.unchanged():
        progress.emit({'stage': 'validating', 'completedChapters': chapter_count, 'totalChapters': chapter_count})
        return finish({'preview': preview, 'output': 'input.epub'})
    if operation in ('update', 'refresh'):
        from fanficfare.epubutils import get_update_data
        validate_epub('input.epub', LIBRARY_EPUB_LIMIT)
        old = get_update_data('input.epub')
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
        if operation == 'update' and not request.get('checkStatePath'):
            (adapter.oldchapters, adapter.oldimgs, adapter.oldcover, adapter.calibrebookmark,
             adapter.logfile, adapter.oldchaptersmap, adapter.oldchaptersdata) = old[2:9]
            if saved_placeholder:
                del adapter.oldchaptersmap[saved_placeholder]
                # Once the empty page is gone, positional fallback could reuse it
                # for a different chapter or conceal newly published intro content.
                if not adapter.oldchaptersmap:
                    adapter.oldchapters = None
    with open('output.epub', 'xb') as output:
        progress.total = chapter_count
        progress.emit({'stage': 'downloading', 'completedChapters': 0, 'totalChapters': chapter_count})
        with recover_chapters(adapter, check.chapter_directory(request.get('chapterDirectory')), canonical, transport) as downloaded:
            progress.downloaded = downloaded
            writers.getWriter('epub', configuration, adapter).writeStory(outstream=output, notification=progress.chapters)
        if transport.failure is not None:
            raise transport.failure
        output.flush()
        os.fsync(output.fileno())
    progress.emit({'stage': 'validating', 'completedChapters': chapter_count, 'totalChapters': chapter_count})
    validate_epub('output.epub', LIBRARY_EPUB_LIMIT if operation in ('update', 'refresh') else NEW_EPUB_LIMIT)
    if operation in ('update', 'refresh'):
        preserve_chapter_locks('input.epub', 'output.epub')
        preserve_policy('input.epub', 'output.epub', continuation)
        if continuation is not None:
            validate_output('output.epub', continuation_chapters)
    check.save('output.epub')
    return finish({'preview': matched_preview(adapter.story, story_preview(adapter, adapter.story)), 'output': 'output.epub'})


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
    if isinstance(error, (sqlite3.Error, CheckpointStorageError)) or isinstance(error, OSError) and error.errno in (28, 30):
        return 'chapter_storage_failed'
    if isinstance(error, PolicyError):
        return error.code
    if isinstance(error, TimeoutError):
        return 'download_timeout'
    if status == 429:
        return 'source_rate_limited'
    if status is not None and status >= 500:
        return 'source_unavailable'
    if name == 'StoryDoesNotExist' or status in (404, 410):
        return 'source_not_found'
    return 'source_failed'


def main():
    logging.disable(logging.CRITICAL)
    install_network_guard()
    try:
        raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise PolicyError('Input limit exceeded')
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise PolicyError('Invalid integration request')
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
