import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from update_check import UpdateCheck, VERIFY_INTERVAL


class UpdateCheckTest(unittest.TestCase):
    def test_import_resumes_after_new_chapters_metadata_changes_and_week_rollover(self):
        adapter = Mock()
        adapter.get_chapters.return_value = [{'url': 'one', 'title': 'One'}]
        adapter.story.img_store.get_imgs.return_value = []
        with tempfile.TemporaryDirectory() as directory:
            request = {'operation': 'download', 'checkStatePath': str(Path(directory) / 'state.json')}
            with patch('update_check.time.time', return_value=1000):
                first = UpdateCheck(request, adapter, {'chapterCount': 1})
                import hashlib
                legacy_key = hashlib.sha256(f'{first.chapter_fingerprint}:None:0'.encode()).hexdigest()
                legacy = Path(directory, legacy_key)
                legacy.mkdir()
                (legacy / 'saved').write_bytes(b'chapter one')
                first_path = Path(first.chapter_directory(directory))
            adapter.get_chapters.return_value.append({'url': 'two', 'title': 'Two'})
            with patch('update_check.time.time', return_value=1000 + VERIFY_INTERVAL):
                preview = {'chapterCount': 2, 'rawLabels': ['new label']}
                resumed = Path(UpdateCheck(request, adapter, preview).chapter_directory(directory))
                self.assertEqual(resumed, first_path)
                self.assertEqual((resumed / 'saved').read_bytes(), b'chapter one')
                changed = UpdateCheck({**request, 'configuration': 'different'}, adapter, preview)
                self.assertNotEqual(Path(changed.chapter_directory(directory)), resumed)

    def test_tag_reviews_refresh_metadata_without_restarting_current_chapters(self):
        import hashlib
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                Path('input.epub').write_bytes(b'saved book')
                adapter = Mock()
                adapter.get_chapters.return_value = [{'url': 'chapter', 'title': 'One'}]
                adapter.story.getMetadataRaw.return_value = '2026-11-12'
                adapter.story.img_store.get_imgs.return_value = []
                request = {'operation': 'update', 'checkStatePath': str(Path(directory) / 'state.json'),
                           'configuration': 'private', 'tagMatching': {'version': 1, 'rules': []}}
                preview = {'status': 'Completed', 'chapterCount': 1, 'tags': ['old-tag'], 'genres': [],
                           'rawLabels': [{'field': 'fandoms', 'value': 'Original source label'}],
                           'categories': {'fandoms': ['old-tag']}, 'pendingLabelCount': 1, 'labelMappingVersion': 1}
                with patch('update_check.time.time', return_value=1000):
                    old = UpdateCheck(request, adapter, preview)
                    old.save('input.epub')
                    identity = f'{old.fingerprint}:{old.input_hash}:0'
                    legacy = Path('chapters') / hashlib.sha256(identity.encode()).hexdigest()
                    legacy.mkdir(parents=True)
                    (legacy / 'completed.chapter').write_bytes(b'downloaded body')
                    current = old.chapter_directory('chapters')
                    self.assertEqual((Path(current) / 'completed.chapter').read_bytes(), b'downloaded body')
                    updated = UpdateCheck({**request, 'tagMatching': {'version': 2, 'rules': ['new match']}},
                                          adapter, {**preview, 'tags': ['new-tag'], 'genres': ['new-genre'],
                                                    'categories': {'fandoms': ['new-tag']},
                                                    'pendingLabelCount': 0, 'labelMappingVersion': 2})
                    self.assertFalse(updated.unchanged())
                    self.assertEqual(updated.chapter_directory('chapters'), current)
                    self.assertNotEqual(UpdateCheck(request, adapter, {**preview, 'rawLabels': []}).chapter_directory('chapters'), current)
                    self.assertNotEqual(UpdateCheck({**request, 'configuration': 'changed'}, adapter, preview).chapter_directory('chapters'), current)
                    adapter.get_chapters.return_value.append({'url': 'new chapter', 'title': 'Two'})
                    self.assertNotEqual(UpdateCheck(request, adapter, preview).chapter_directory('chapters'), current)
                    adapter.get_chapters.return_value.pop()
                    Path('input.epub').write_bytes(b'changed saved book')
                    self.assertNotEqual(UpdateCheck(request, adapter, preview).chapter_directory('chapters'), current)
            finally:
                os.chdir(original)

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
