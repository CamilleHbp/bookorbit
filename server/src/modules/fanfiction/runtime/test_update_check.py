import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from update_check import UpdateCheck, VERIFY_INTERVAL


class UpdateCheckTest(unittest.TestCase):
    def test_managed_updates_skip_unchanged_chapters_and_periodically_catch_silent_edits(self):
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        from fanficfare_wrapper import run
        from zipfile import ZipFile
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                request = {
                    'operation': 'download', 'url': 'https://test1.com/?sid=1', 'configuration': '',
                    'chapterDirectory': str(Path(directory) / 'chapters'),
                    'checkStatePath': str(Path(directory) / 'state.json'),
                }
                text = ['Original chapter']
                def chapter(adapter, url):
                    return adapter.utf8FromSoup(url, adapter.make_soup('<p>' + text[0] + '</p>'))
                with patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'getChapterText', autospec=True, side_effect=chapter) as fetched:
                    run(request)
                    Path('output.epub').replace('input.epub')
                    fetched.reset_mock()
                    request['operation'] = 'update'
                    self.assertEqual(run(request)['output'], 'input.epub')
                    fetched.assert_not_called()
                    text[0] = 'Silently edited chapter'
                    state = json.loads(Path(request['checkStatePath']).read_text())
                    state['verifiedAt'] -= VERIFY_INTERVAL
                    Path(request['checkStatePath']).write_text(json.dumps(state))
                    self.assertEqual(run(request)['output'], 'output.epub')
                    self.assertGreater(fetched.call_count, 0)
                    with ZipFile('output.epub') as archive:
                        chapters = b''.join(archive.read(name) for name in archive.namelist() if name.endswith('.xhtml'))
                        self.assertIn(b'Silently edited chapter', chapters)
                    Path('output.epub').replace('input.epub')
                    fetched.reset_mock()
                    self.assertEqual(run(request)['output'], 'input.epub')
                    fetched.assert_not_called()
                    request['operation'] = 'refresh'
                    request['chapterDirectory'] = str(Path(directory) / 'explicit-refresh')
                    self.assertEqual(run(request)['output'], 'output.epub')
                    self.assertGreater(fetched.call_count, 0)
            finally:
                os.chdir(original)

    def test_fast_check_is_bound_to_source_configuration_revision_and_age(self):
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                Path('input.epub').write_bytes(b'saved book')
                adapter = Mock()
                adapter.get_chapters.return_value = [{'url': 'chapter', 'title': 'One'}]
                adapter.story.getMetadataRaw.return_value = '2026-11-12'
                adapter.story.img_store.get_imgs.return_value = []
                request = {'operation': 'update', 'checkStatePath': str(Path(directory) / 'state.json'), 'configuration': 'private'}
                preview = {'status': 'Completed', 'chapterCount': 1}
                with patch('update_check.time.time', return_value=1000):
                    check = UpdateCheck(request, adapter, preview)
                    self.assertFalse(check.unchanged())
                    check.save('input.epub')
                    self.assertTrue(UpdateCheck(request, adapter, preview).unchanged())
                    self.assertFalse(UpdateCheck({**request, 'configuration': 'changed'}, adapter, preview).unchanged())
                    self.assertFalse(UpdateCheck(request, adapter, {**preview, 'chapterCount': 2}).unchanged())
                    adapter.get_chapters.return_value.append({'url': 'new chapter', 'title': 'Two'})
                    self.assertFalse(UpdateCheck(request, adapter, preview).unchanged())
                    adapter.get_chapters.return_value.pop()
                    Path('input.epub').write_bytes(b'changed local book')
                    self.assertFalse(UpdateCheck(request, adapter, preview).unchanged())
                    Path('input.epub').write_bytes(b'saved book')
                with patch('update_check.time.time', return_value=1000 + VERIFY_INTERVAL):
                    expired = UpdateCheck(request, adapter, preview)
                    self.assertFalse(expired.unchanged())
                    self.assertNotEqual(check.chapter_directory('chapters'), expired.chapter_directory('chapters'))
                with patch('update_check.time.time', return_value=999):
                    self.assertFalse(UpdateCheck(request, adapter, preview).unchanged())
                state = json.loads(Path(request['checkStatePath']).read_text())
                self.assertNotIn('private', json.dumps(state))
                for broken in ['not json', '[]', '{}', 'x' * 4097]:
                    Path(request['checkStatePath']).write_text(broken)
                    self.assertFalse(UpdateCheck(request, adapter, preview).unchanged())
            finally:
                os.chdir(original)


if __name__ == '__main__':
    unittest.main()
