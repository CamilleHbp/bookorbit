import os
import sqlite3
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
                with closing(sqlite3.connect(Path(directory, 'normal', 'chapters.sqlite'))) as db, db:
                    db.execute("UPDATE chapters SET body=x'ff' WHERE rowid=(SELECT min(rowid) FROM chapters)")
                before_repair = len(calls)
                run({**payload, 'operation': 'download'})
                self.assertEqual(len(calls), before_repair + 1)
                self.assertEqual(calls[-1], first)
                Path('output.epub').unlink()
                with closing(sqlite3.connect(Path(directory, 'normal', 'chapters.sqlite'))) as db, db:
                    db.execute("UPDATE images SET data=x'00'")
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
