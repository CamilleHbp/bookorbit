import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from controlled_config import merge_configuration, validate_ini
from epub_policy import validate_epub
from fanficfare_wrapper import run, execute_request
from safe_transport import PolicyError


class ConfigurationTest(unittest.TestCase):
    def test_source_covers_are_embedded_on_download_update_and_refresh(self):
        import base64
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        from safe_transport import SafeTransport
        image = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=')
        extract = TestSiteAdapter.doExtractChapterUrlsAndMetadata
        fetched = []

        def metadata(adapter, get_cover=True):
            extract(adapter, get_cover=get_cover)
            if get_cover:
                adapter.setCoverImage(adapter.url, 'https://test1.com/cover.png')

        def request(_transport, method, url, parameters=None, headers=None):
            self.assertEqual(url, 'https://test1.com/cover.png')
            fetched.append(url)
            return 200, image, url

        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory, patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'doExtractChapterUrlsAndMetadata', metadata), patch.object(SafeTransport, 'request', request):
            try:
                os.chdir(directory)
                payload = {'url': 'https://test1.com/?sid=1', 'configuration': ''}
                run({**payload, 'operation': 'preview'})
                self.assertEqual(fetched, [])
                for operation in ['download', 'update', 'refresh']:
                    with self.subTest(operation=operation):
                        run({**payload, 'operation': operation})
                        with ZipFile('output.epub') as archive:
                            opf = next(name for name in archive.namelist() if name.endswith('.opf'))
                            self.assertIn(b'name="cover"', archive.read(opf))
                            self.assertTrue(any(archive.read(name) == image for name in archive.namelist()))
                        Path('output.epub').replace('input.epub')
                self.assertEqual(len(fetched), 3)
            finally:
                os.chdir(original)

    def test_fictionlive_covers_default_to_enabled_and_respect_profile_settings(self):
        from controlled_config import make_configuration
        from fanficfare.adapters.adapter_fictionlive import FictionLiveAdapter
        from safe_transport import SafeTransport
        url = 'https://fiction.live/stories/Example/17CharacterIDhere/home'
        data = {'t': 'Example', 'cht': 1700000000000, 'rt': 1690000000000,
                'contentRating': 'teen', 'u': [{'n': 'Writer', '_id': 'writer-id'}],
                'i': ['https://example.org/cover.png'], 'nsfwCover': True}
        configuration = make_configuration(url, '', SafeTransport([]))
        self.assertEqual(configuration.getConfig('include_images'), 'true')
        adapter = FictionLiveAdapter(configuration, url)
        with patch.object(adapter, 'setCoverImage') as cover:
            adapter.extract_metadata(data, True)
            cover.assert_called_once_with(adapter.url, data['i'][0])
        configuration = make_configuration(url, '[defaults]\ninclude_images: false\n[fiction.live]\nshow_nsfw_cover_images: false\n', SafeTransport([]))
        self.assertFalse(configuration.getConfig('include_images'))
        adapter = FictionLiveAdapter(configuration, url)
        with patch.object(adapter, 'setCoverImage') as cover:
            adapter.extract_metadata(data, True)
            cover.assert_not_called()

    def test_uses_raw_chapter_and_word_counts_instead_of_formatted_metadata(self):
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        original = TestSiteAdapter.getStoryMetadataOnly

        def metadata(adapter, *args, **kwargs):
            story = original(adapter, *args, **kwargs)
            story.setMetadata('numChapters', 1000)
            story.setMetadata('numWords', 123456)
            self.assertEqual(story.getMetadata('numChapters'), '1,000')
            return story

        with patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'getStoryMetadataOnly', metadata):
            preview = run({'operation': 'preview', 'url': 'https://test1.com/?sid=1', 'configuration': '[defaults]\ninclude_images: false\n'})
        self.assertEqual(preview['chapterCount'], 1000)
        self.assertEqual(preview['wordCount'], 123456)

    def test_unknown_or_unbounded_word_counts_are_not_estimated(self):
        from fanficfare_wrapper import metadata_count
        from unittest.mock import Mock
        for value in [None, '', 'unknown', '1.2k', -1, 1.5, True, 2147483648, '9' * 40]:
            with self.subTest(value=value):
                self.assertIsNone(metadata_count(Mock(getMetadataRaw=Mock(return_value=value)), 'numWords', 2147483647))
        self.assertEqual(metadata_count(Mock(getMetadataRaw=Mock(return_value='0')), 'numWords', 2147483647), 0)

    def test_returned_login_cookies_are_separate_from_the_public_preview(self):
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        from safe_transport import SafeTransport
        cookie = {'name': 'session', 'value': 'renewed-secret', 'domain': 'test1.com', 'path': '/', 'secure': True, 'hostOnly': True}
        with patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(SafeTransport, 'export_cookies', return_value=[cookie]):
            response = execute_request({'operation': 'preview', 'url': 'https://test1.com/?sid=1', 'configuration': '[defaults]\ninclude_images: false\n'})
        self.assertEqual(response['cookies'], [cookie])
        self.assertNotIn('cookies', response['result'])
        self.assertNotIn('renewed-secret', str(response['result']))

    def test_http_authentication_failures_are_configuration_blocked_instead_of_retried(self):
        from fanficfare.exceptions import HTTPErrorFFF
        from fanficfare_wrapper import failure_code
        for status in [401]:
            self.assertEqual(failure_code(HTTPErrorFFF('https://example.org/private', status, 'secret response')), 'authentication_required')
        self.assertEqual(failure_code(HTTPErrorFFF('https://example.org/private', 403, 'secret response')), 'access_denied')
        for status in [429, 500, 503]:
            self.assertEqual(failure_code(HTTPErrorFFF('https://example.org/story', status, 'server error')), 'source_failed')
        self.assertEqual(failure_code(PolicyError('Unsafe setting')), 'configuration_blocked')

    def test_fictionlive_mature_story_requires_confirmation_not_a_password(self):
        from fanficfare.adapters.adapter_fictionlive import FictionLiveAdapter
        from fanficfare.exceptions import AdultCheckRequired
        from fanficfare_wrapper import failure_code
        from controlled_config import make_configuration
        from safe_transport import SafeTransport
        url = 'https://fiction.live/stories/Example/17CharacterIDhere/home'
        data = {'t': 'Example', 'cht': 1700000000000, 'rt': 1690000000000,
                'contentRating': 'nsfw', 'u': [{'n': 'Writer', '_id': 'writer-id'}]}
        settings = '[fiction.live]\nusername: reader\npassword: secret\ndedup_img_files: true\ninclude_appendices: true\nlegend_spoilers: true\n'
        adapter = FictionLiveAdapter(make_configuration(url, settings, SafeTransport([])), url)
        with self.assertRaises(AdultCheckRequired) as raised:
            adapter.extract_metadata(data, False)
        self.assertEqual(failure_code(raised.exception), 'adult_confirmation_required')
        settings = merge_configuration(settings, edits={'section': 'fiction.live', 'isAdult': True})
        adapter = FictionLiveAdapter(make_configuration(url, settings, SafeTransport([])), url)
        adapter.extract_metadata(data, False)
        self.assertEqual(adapter.story.getMetadata('title'), 'Example')

    def test_curated_sources_match_the_pinned_adapter_configuration_sections(self):
        from fanficfare import adapters
        for section in ['fiction.live', 'archiveofourown.org', 'www.royalroad.com',
                        'forums.spacebattles.com', 'forums.sufficientvelocity.com',
                        'forum.questionablequesting.com', 'www.fanfiction.net', 'www.fictionpress.com']:
            with self.subTest(section=section):
                self.assertIn(section, adapters.getConfigSectionsFor('https://' + section))

    def test_recognizes_canonical_urls_without_network_or_authenticated_access(self):
        from safe_transport import SafeTransport
        with patch.object(SafeTransport, 'request', side_effect=AssertionError('Recognition must stay offline')):
            result = run({'operation': 'recognize', 'urls': ['https://archiveofourown.org/works/12345/chapters/45678', 'https://example.org/no-adapter', 'file:///etc/passwd']})
        self.assertEqual(result[0], {'url': 'https://archiveofourown.org/works/12345/chapters/45678', 'recognized': True, 'canonicalUrl': 'https://archiveofourown.org/works/12345', 'site': 'archiveofourown.org'})
        self.assertEqual(result[1]['reason'], 'unsupported')
        self.assertEqual(result[2]['reason'], 'unsafe')
        self.assertNotIn('authenticated', result[0])

    def test_site_catalog_excludes_fixture_adapters_and_recognition_is_bounded(self):
        self.assertFalse(any(site['id'] in ['test1.com', 'test2.com'] for site in run({'operation': 'sites'})['sites']))
        with self.assertRaises(PolicyError):
            run({'operation': 'recognize', 'urls': ['https://example.org'] * 101})

    def test_rejects_unsafe_advanced_options_in_every_section(self):
        for option in ['pre_process_cmd', 'post_process_cmd', 'use_browser_cache', 'http_proxy', 'https_proxy', 'use_flaresolverr_proxy', 'use_nsapa_proxy', 'browser_cache_path', 'username_filelist', 'output_filename', 'include_images_filelist', 'use_ssl_default_seclevelone']:
            with self.subTest(option=option), self.assertRaises(PolicyError):
                validate_ini('[archiveofourown.org:epub]\n' + option + ': unsafe\n')

    def test_preserves_explicit_advanced_sections(self):
        value = '[defaults]\ninclude_titlepage: true\n[archiveofourown.org]\nusername: reader\npassword: hidden\n'
        self.assertEqual(validate_ini(value), value)

    def test_masked_secrets_are_unchanged_and_structured_edits_preserve_advanced_sections(self):
        previous = '[defaults]\ninclude_titlepage: true\n[archiveofourown.org]\npassword: secret\n'
        masked = merge_configuration(previous, redact=True)
        self.assertNotIn('secret', masked)
        restored = merge_configuration(previous, masked, {'section': 'archiveofourown.org', 'username': 'reader'})
        self.assertIn('password = secret', restored)
        self.assertIn('include_titlepage = true', restored)
        cleared = merge_configuration(restored, edits={'section': 'archiveofourown.org', 'password': ''})
        self.assertNotIn('secret', cleared)

    def test_hostile_archive_paths(self):
        for filename in ['../outside', '/outside', 'C:/outside', 'a\\outside']:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'hostile.epub'
                with ZipFile(path, 'w') as archive:
                    archive.writestr(filename, 'bad')
                with self.assertRaises(PolicyError):
                    validate_epub(path)

    def test_pinned_adapter_can_generate_and_update_an_epub_without_cli_configuration(self):
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory, patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'):
            try:
                os.chdir(directory)
                Path('personal.ini').write_text('[defaults]\npre_process_cmd: invalid\noutput_filename: outside.epub\n')
                request = {'operation': 'download', 'url': 'https://test1.com/?sid=1', 'configuration': '[defaults]\ninclude_images: false\nextratags: Remote tag\n', 'tagRules': [{'remoteTag': 'Remote tag', 'targetTag': 'Mapped tag'}]}
                progress = []
                result = run(request, report_progress=progress.append)
                self.assertEqual(progress[0], {'stage': 'metadata'})
                chapters = [item for item in progress if item['stage'] == 'downloading']
                self.assertEqual(chapters[0]['completedChapters'], 0)
                self.assertEqual(chapters[-1]['completedChapters'], result['preview']['chapterCount'])
                self.assertEqual([item['stage'] for item in progress[-2:]], ['packaging', 'validating'])
                self.assertEqual(result['output'], 'output.epub')
                self.assertIn('Mapped tag', result['preview']['tags'])
                self.assertNotIn('Remote tag', result['preview']['tags'])
                self.assertGreater(validate_epub('output.epub'), 2)
                Path('output.epub').rename('input.epub')
                with patch.object(TestSiteAdapter, 'getChapterText', side_effect=AssertionError('Existing chapters must be preserved')):
                    result = run({**request, 'operation': 'update'})
                self.assertEqual(result['output'], 'output.epub')
                self.assertIn('Mapped tag', result['preview']['tags'])
                self.assertNotIn('Remote tag', result['preview']['tags'])
                Path('output.epub').unlink()
                original_chapter = TestSiteAdapter.getChapterText
                refreshed = []

                def chapter(adapter, url):
                    refreshed.append(url)
                    adapter.story.setMetadata('numWords', 234567)
                    adapter.story.setMetadata('title', 'Refreshed story title')
                    return original_chapter(adapter, url) + '<p>Refreshed passage.</p>'

                with patch.object(TestSiteAdapter, 'getChapterText', chapter):
                    refreshed_result = run({**request, 'operation': 'refresh'})
                self.assertEqual(refreshed_result['preview']['wordCount'], 234567)
                self.assertEqual(refreshed_result['preview']['title'], 'Refreshed story title')
                self.assertGreater(len(refreshed), 0)
                with ZipFile('output.epub') as archive:
                    opf = next(name for name in archive.namelist() if name.endswith('.opf'))
                    self.assertIn(b'>Mapped tag<', archive.read(opf))
                    self.assertNotIn(b'>Remote tag<', archive.read(opf))
                    self.assertTrue(any(b'Refreshed passage.' in archive.read(name) for name in archive.namelist() if name.endswith('.xhtml')))
                self.assertFalse(Path('outside.epub').exists())
            finally:
                os.chdir(original)


if __name__ == '__main__':
    unittest.main()
