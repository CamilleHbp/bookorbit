import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import importlib.metadata
import json
import logging
import os
import resource

from controlled_config import make_configuration, merge_configuration, validate_ini
from epub_policy import validate_epub
from safe_transport import PolicyError, SafeTransport, install_network_guard, validate_url

VERSION = '4.61.0'
TEST_SITES = {'test1.com', 'test2.com'}


class RecognitionNeedsAccess(Exception):
    pass


class RecognitionTransport(SafeTransport):
    def request(self, method, url, parameters=None, headers=None):
        raise RecognitionNeedsAccess()


def recognize_urls(urls):
    from fanficfare import adapters, exceptions
    if not isinstance(urls, list) or not 0 < len(urls) <= 100:
        raise PolicyError('URL recognition batch exceeds its limit')
    result = []
    for url in urls:
        if not isinstance(url, str) or len(url) > 4096:
            raise PolicyError('Invalid URL recognition input')
        try:
            validate_url(url)
            adapter = adapters.getAdapter(make_configuration(url, '', RecognitionTransport()), url)
            canonical = adapter.url.replace('http://', 'https://', 1)
            validate_url(canonical)
            site = adapter.getSiteDomain()
            if site.removeprefix('www.') in TEST_SITES:
                result.append({'url': url, 'recognized': False, 'reason': 'unsupported'})
            else:
                result.append({'url': url, 'recognized': True, 'canonicalUrl': canonical, 'site': site})
        except (exceptions.UnknownSite, exceptions.InvalidStoryURL):
            result.append({'url': url, 'recognized': False, 'reason': 'unsupported'})
        except RecognitionNeedsAccess:
            result.append({'url': url, 'recognized': False, 'reason': 'access_required'})
        except PolicyError:
            result.append({'url': url, 'recognized': False, 'reason': 'unsafe'})
    return result


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))


def run(request, save_cookies=None):
    actual = importlib.metadata.version('FanFicFare')
    if actual != VERSION:
        raise PolicyError('Pinned FanFicFare runtime version does not match')
    from fanficfare import adapters, writers
    operation = request.get('operation')
    if operation == 'health':
        return {'version': actual, 'protocolVersion': 1, 'ready': True}
    if operation == 'sites':
        examples = adapters.getSiteExamples()
        return {'version': actual, 'sites': [{'id': site, 'examples': urls[:3]} for site, urls in examples if site.removeprefix('www.') not in TEST_SITES]}
    if operation == 'recognize':
        return recognize_urls(request.get('urls'))
    if operation == 'merge':
        return {'configuration': merge_configuration(request.get('previous', ''), request.get('configuration'), request.get('edits'), request.get('redact', False))}
    ini = validate_ini(request.get('configuration', ''))
    if operation == 'validate':
        return {'valid': True}
    url = request.get('url')
    validate_url(url)
    transport = SafeTransport()
    transport.load_cookies(request.get('cookies', []))
    def finish(result):
        if save_cookies is not None:
            save_cookies(transport.export_cookies())
        return result
    configuration = make_configuration(url, ini, transport)
    adapter = adapters.getAdapter(configuration, url)
    story = adapter.getStoryMetadataOnly(get_cover=False)
    canonical = story.getMetadata('storyUrl')
    validate_url(canonical.replace('http://', 'https://', 1))
    chapter_count = int(story.getMetadata('numChapters') or 0)
    if not 0 < chapter_count <= 10_000:
        raise PolicyError('Chapter count limit exceeded')
    preview = {
        'canonicalUrl': canonical.replace('http://', 'https://', 1),
        'site': adapter.getConfigSection(), 'title': story.getMetadata('title'),
        'authors': story.getList('author'), 'description': story.getMetadata('description'),
        'chapterCount': chapter_count, 'status': story.getMetadata('status'),
        'tags': story.getSubjectTags(),
    }
    if operation == 'preview':
        return finish(preview)
    if operation not in ('download', 'update', 'refresh'):
        raise PolicyError('Unsupported integration operation')
    if operation in ('update', 'refresh'):
        from fanficfare.epubutils import get_update_data
        validate_epub('input.epub')
        old = get_update_data('input.epub')
        previous_url, previous_count = old[:2]
        if adapters.getNormalStoryURL(previous_url) != adapters.getNormalStoryURL(canonical):
            return finish({'reviewRequired': 'identity_mismatch', 'preview': preview})
        if previous_count > chapter_count:
            return finish({'reviewRequired': 'chapter_reduction', 'preview': preview})
        if operation == 'update':
            (adapter.oldchapters, adapter.oldimgs, adapter.oldcover, adapter.calibrebookmark,
             adapter.logfile, adapter.oldchaptersmap, adapter.oldchaptersdata) = old[2:9]
    with open('output.epub', 'xb') as output:
        writers.getWriter('epub', configuration, adapter).writeStory(outstream=output)
        output.flush()
        os.fsync(output.fileno())
    validate_epub('output.epub')
    return finish({'preview': preview, 'output': 'output.epub'})


def execute_request(request):
    cookies = []
    result = run(request, cookies.extend)
    return {'ok': True, 'result': result, 'cookies': cookies}


def failure_code(error):
    if type(error).__name__ in ('FailedToLogin', 'AdultCheckRequired', 'AccessDenied') or (
            type(error).__name__ == 'HTTPErrorFFF' and getattr(error, 'status_code', None) in (401, 403)):
        return 'authentication_required'
    return 'configuration_blocked' if isinstance(error, (PolicyError, ValueError)) else 'source_failed'


def main():
    limits()
    logging.disable(logging.CRITICAL)
    install_network_guard()
    try:
        raw = sys.stdin.buffer.read(512 * 1024 + 1)
        if len(raw) > 512 * 1024:
            raise PolicyError('Input limit exceeded')
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise PolicyError('Invalid integration request')
        result = execute_request(request)
    except Exception as error:
        name = type(error).__name__
        code = failure_code(error)
        result = {'ok': False, 'code': code, 'errorClass': name}
    encoded = json.dumps(result, ensure_ascii=True)
    if len(encoded) > 1024 * 1024:
        encoded = '{"ok":false,"code":"output_limit","errorClass":"PolicyError"}'
    sys.stdout.write(encoded)


if __name__ == '__main__':
    main()
