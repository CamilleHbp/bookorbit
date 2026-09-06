import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from controlled_config import merge_configuration, validate_ini
from epub_policy import validate_epub
from fanficfare_wrapper import run
from safe_transport import PolicyError


class ConfigurationTest(unittest.TestCase):
    def test_http_authentication_failures_are_configuration_blocked_instead_of_retried(self):
        from fanficfare.exceptions import HTTPErrorFFF
        from fanficfare_wrapper import failure_code
        for status in [401, 403]:
            self.assertEqual(failure_code(HTTPErrorFFF('https://example.org/private', status, 'secret response')), 'authentication_required')
        for status in [429, 500, 503]:
            self.assertEqual(failure_code(HTTPErrorFFF('https://example.org/story', status, 'server error')), 'source_failed')
        self.assertEqual(failure_code(PolicyError('Unsafe setting')), 'configuration_blocked')

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
                request = {'operation': 'download', 'url': 'https://test1.com/?sid=1', 'configuration': '[defaults]\ninclude_images: false\n'}
                result = run(request)
                self.assertEqual(result['output'], 'output.epub')
                self.assertGreater(validate_epub('output.epub'), 2)
                Path('output.epub').rename('input.epub')
                with patch.object(TestSiteAdapter, 'getChapterText', side_effect=AssertionError('Existing chapters must be preserved')):
                    result = run({**request, 'operation': 'update'})
                self.assertEqual(result['output'], 'output.epub')
                Path('output.epub').unlink()
                original_chapter = TestSiteAdapter.getChapterText
                refreshed = []

                def chapter(adapter, url):
                    refreshed.append(url)
                    return original_chapter(adapter, url) + '<p>Refreshed passage.</p>'

                with patch.object(TestSiteAdapter, 'getChapterText', chapter):
                    run({**request, 'operation': 'refresh'})
                self.assertGreater(len(refreshed), 0)
                with ZipFile('output.epub') as archive:
                    self.assertTrue(any(b'Refreshed passage.' in archive.read(name) for name in archive.namelist() if name.endswith('.xhtml')))
                self.assertFalse(Path('outside.epub').exists())
            finally:
                os.chdir(original)


if __name__ == '__main__':
    unittest.main()
