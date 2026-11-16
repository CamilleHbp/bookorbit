import os
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from zipfile import ZipFile

from fanficfare_wrapper import run
from fanficfare.adapters.adapter_test1 import TestSiteAdapter
from safe_transport import SafeTransport


class ChapterRecoveryTest(unittest.TestCase):
    def test_full_download_does_not_publish_a_partial_epub_when_a_cpu_slice_yields(self):
        from chapter_store import ChapterDownloadYield
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            os.chdir(directory)
            self.addCleanup(os.chdir, original)
            request = {'operation': 'download', 'url': 'https://test1.com/?sid=1', 'configuration': '',
                       'chapterDirectory': str(Path(directory, 'chapters'))}
            calls = []

            def chapter(adapter, url):
                calls.append(url)
                return '<div>Complete chapter</div>'

            with patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), \
                    patch.object(TestSiteAdapter, 'getChapterText', chapter):
                with patch('chapter_store.time.process_time', return_value=481), self.assertRaises(ChapterDownloadYield):
                    run(request)
                self.assertEqual(len(calls), 1)
                saved = calls[0]
                Path('output.epub').unlink()
                with patch('chapter_store.time.process_time', return_value=1):
                    result = run(request)
                self.assertEqual(result['output'], 'output.epub')
                self.assertEqual(calls.count(saved), 1)

    def test_cpu_slice_yields_after_a_durable_chapter_and_resumes_without_refetching_it(self):
        from chapter_store import ChapterDownloadYield, recover_chapters
        from fanficfare_wrapper import failure_code
        adapter = Mock()
        adapter.get_chapters.return_value = [{'url': 'first'}, {'url': 'second'}]
        adapter.normalize_chapterurl.side_effect = lambda url: url
        adapter.getChapterTextNum.side_effect = lambda url, index: '<p>' + url + '</p>'
        original = adapter.getChapterTextNum
        transport = Mock(failure=None)
        with tempfile.TemporaryDirectory() as directory:
            with patch('chapter_store.time.process_time', return_value=481):
                with recover_chapters(adapter, directory, 'story', transport):
                    self.assertEqual(adapter.getChapterTextNum('first', 0), '<p>first</p>')
                    with self.assertRaises(ChapterDownloadYield) as raised:
                        adapter.getChapterTextNum('second', 1)
                    self.assertIs(transport.failure, raised.exception)
                    self.assertEqual(failure_code(raised.exception), 'chapter_download_yielded')
                self.assertIs(adapter.getChapterTextNum, original)
            with patch('chapter_store.time.process_time', return_value=1):
                with recover_chapters(adapter, directory, 'story', Mock(failure=None)):
                    self.assertEqual(adapter.getChapterTextNum('first', 0), '<p>first</p>')
                    self.assertEqual(adapter.getChapterTextNum('second', 1), '<p>second</p>')
            self.assertEqual(original.call_count, 2)

    def test_empty_ranges_do_not_count_as_durable_progress_for_a_cpu_slice(self):
        from chapter_store import recover_chapters
        adapter = Mock()
        adapter.get_chapters.return_value = [{'url': 'first'}, {'url': 'second'}]
        adapter.normalize_chapterurl.side_effect = lambda url: url
        adapter.getSiteDomain.return_value = 'fiction.live'
        adapter.getChapterTextNum.return_value = ''
        transport = Mock(failure=None)
        with tempfile.TemporaryDirectory() as directory, patch('chapter_store.time.process_time', return_value=481):
            with recover_chapters(adapter, directory, 'story', transport):
                self.assertEqual(adapter.getChapterTextNum('first', 0), '<div></div>')
                self.assertEqual(adapter.getChapterTextNum('second', 1), '<div></div>')
            self.assertIsNone(transport.failure)

    def test_synthetic_home_is_omitted_only_for_an_empty_fictionlive_range(self):
        from fanficfare_wrapper import omit_empty_fictionlive_home
        adapter = Mock()
        adapter.getSiteDomain.return_value = 'fiction.live'
        adapter.chapter_id_to_api = {'home': 'intro'}
        adapter.get_chapters.return_value = [{'url': 'intro'}, {'url': 'chapter'}]
        adapter.get_request.side_effect = ['[{"nt":"chapter"}]', '[{"t":"#special art"},{"nt":"choice"}]',
                                           '[{"t":"#special appendix"}]', '[]']
        self.assertIsNone(omit_empty_fictionlive_home(adapter))
        self.assertIsNone(omit_empty_fictionlive_home(adapter))
        adapter.del_chapter.assert_not_called()
        self.assertEqual(omit_empty_fictionlive_home(adapter), 'intro')
        adapter.del_chapter.assert_called_once_with(0)
        adapter.del_chapter.reset_mock()
        self.assertEqual(omit_empty_fictionlive_home(adapter), 'intro')
        adapter.del_chapter.assert_called_once_with(0)
        adapter.getSiteDomain.return_value = 'another.example'
        self.assertIsNone(omit_empty_fictionlive_home(adapter))
        self.assertEqual(adapter.get_request.call_count, 4)

    def test_old_home_is_rechecked_without_dropping_illustrated_introductions(self):
        from bs4 import BeautifulSoup
        from fanficfare_wrapper import empty_saved_home_url
        adapter = Mock()
        adapter.getSiteDomain.return_value = 'fiction.live'
        adapter.chapter_id_to_api = {'home': 'intro'}
        for html, expected in [('<div></div>', 'intro'), ('<p>First scene</p>', None),
                               ('<div><img src="intro.jpg"/></div>', None)]:
            self.assertEqual(empty_saved_home_url(adapter, {'intro': BeautifulSoup(html, 'html.parser')}), expected)

    def test_empty_fictionlive_ranges_are_rechecked_and_other_empty_downloads_fail(self):
        from chapter_store import recover_chapters
        from safe_transport import SourceResponseError
        adapter = Mock()
        adapter.get_chapters.return_value = [{'url': 'chapter'}]
        adapter.normalize_chapterurl.side_effect = lambda url: url
        adapter.getChapterTextNum.side_effect = ['', '<p>Later</p>', '']
        adapter.getSiteDomain.return_value = 'fiction.live'
        with tempfile.TemporaryDirectory() as directory:
            with recover_chapters(adapter, directory, 'story', Mock(failure=None)):
                self.assertEqual(adapter.getChapterTextNum('chapter', 0), '<div></div>')
                self.assertEqual(adapter.getChapterTextNum('chapter', 0), '<p>Later</p>')
                adapter.getSiteDomain.return_value = 'other.example'
                with self.assertRaises(SourceResponseError):
                    adapter.getChapterTextNum('other', 1)

    def test_retry_update_and_explicit_refresh_reuse_exactly_the_completed_chapters(self):
        from io import BytesIO
        from PIL import Image
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            os.chdir(directory)
            self.addCleanup(os.chdir, original)
            payload = {'url': 'https://test1.com/?sid=1', 'configuration': '', 'chapterDirectory': str(Path(directory, 'normal'))}
            calls = []
            image_fetches = []
            illustration = BytesIO()
            Image.new('RGB', (20, 20), 'red').save(illustration, 'PNG')

            def fetch(_transport, method, url, parameters=None, headers=None):
                image_fetches.append(url)
                return 200, illustration.getvalue(), url

            def chapter(adapter, url):
                calls.append(url)
                if len(calls) == 3:
                    raise TimeoutError('Interrupted')
                return adapter.utf8FromSoup(url, adapter.make_soup('<div>Body <img src="https://test1.com/shared.png"/></div>'))

            with patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'getChapterText', chapter), patch.object(SafeTransport, 'request', fetch):
                with self.assertRaises(TimeoutError):
                    run({**payload, 'operation': 'download'})
                Path('output.epub').unlink()
                first, second, interrupted = calls
                run({**payload, 'operation': 'download'})
                self.assertEqual(calls.count(first), 1)
                self.assertEqual(calls.count(second), 1)
                self.assertEqual(calls.count(interrupted), 2)
                with ZipFile('output.epub') as epub:
                    self.assertTrue(any(name.endswith('.webp') for name in epub.namelist()))
                    self.assertIn(b'Body', epub.read(next(name for name in epub.namelist() if name.endswith('file0001.xhtml'))))
                Path('output.epub').unlink()
                from chapter_checkpoint import digest
                next(Path(directory, 'normal', 'v2', 'chapters').rglob(digest(first.encode()) + '.chapter')).write_bytes(b'broken')
                before_repair = len(calls)
                run({**payload, 'operation': 'download'})
                self.assertEqual(len(calls), before_repair + 1)
                self.assertEqual(calls[-1], first)
                Path('output.epub').unlink()
                for image in Path(directory, 'normal', 'v2', 'images').glob('*/*'):
                    image.write_bytes(b'broken')
                before_repair = len(calls)
                run({**payload, 'operation': 'download'})
                self.assertEqual(len(calls), before_repair + 1)
                Path('output.epub').replace('input.epub')
                count = len(calls)
                run({**payload, 'operation': 'update', 'reviewChanges': True})
                self.assertEqual(len(calls), count)
                Path('output.epub').unlink()
                restart = {**payload, 'operation': 'refresh', 'chapterDirectory': str(Path(directory, 'explicit-restart'))}
                run(restart)
                self.assertGreater(len(calls), count)
                Path('output.epub').unlink()
                after_restart = len(calls)
                run(restart)
                self.assertEqual(len(calls), after_restart)
                self.assertLessEqual(len(image_fetches), 4)


if __name__ == '__main__':
    unittest.main()
