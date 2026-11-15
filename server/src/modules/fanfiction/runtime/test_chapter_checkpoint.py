import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

from chapter_checkpoint import ChapterCheckpoint, CheckpointStorageError, digest


class ChapterCheckpointTest(unittest.TestCase):
    def test_missing_image_and_truncated_record_are_refetched(self):
        from chapter_store import recover_chapters
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            adapter = Mock()
            adapter.get_chapters.return_value = [{'url': 'chapter'}]
            adapter.normalize_chapterurl.side_effect = lambda url: url
            adapter.getChapterTextNum.return_value = '<p>Downloaded again</p>'
            store = ChapterCheckpoint(directory)
            key = (digest(b'story'), digest(b'chapter'))
            references = json.dumps([['images/ffdl-abcd.webp', digest(b'missing'), 'webp', 'image/webp']])
            store.save(key, zlib.compress(b'<p>Old</p>'), references)
            for corrupt in (False, True):
                if corrupt:
                    store.record_path(key).write_bytes(b'\x00\x00\x00\xfftruncated')
                with recover_chapters(adapter, directory, 'story', Mock(failure=None)):
                    self.assertEqual(adapter.getChapterTextNum('chapter', 0), '<p>Downloaded again</p>')
            self.assertEqual(adapter.getChapterTextNum.call_count, 2)
            store.close()

    def test_storage_permissions_are_reported_as_checkpoint_errors(self):
        from fanficfare_wrapper import failure_code
        with tempfile.TemporaryDirectory() as directory:
            store = ChapterCheckpoint(directory)
            with patch('chapter_checkpoint.tempfile.mkstemp', side_effect=PermissionError(13, 'Permission denied')):
                with self.assertRaises(CheckpointStorageError) as error:
                    store.put_image(b'image')
            self.assertEqual(error.exception.errno, 13)
            self.assertEqual(failure_code(error.exception), 'chapter_storage_failed')
            store.close()

    def test_legacy_progress_is_promoted_without_writing_the_old_database(self):
        from chapter_store import recover_chapters
        from unittest.mock import Mock
        body = zlib.compress(b'<p>Saved</p><img src="images/ffdl-abcd.webp"/>')
        image = b'illustration'
        references = json.dumps([['images/ffdl-abcd.webp', digest(image), 'webp', 'image/webp']])
        key = (digest(b'story'), digest(b'chapter'))
        with tempfile.TemporaryDirectory() as directory:
            legacy = Path(directory, 'chapters.sqlite')
            with sqlite3.connect(legacy) as db:
                db.execute('create table chapters (story text,url text,body blob,checksum text,images text)')
                db.execute('create table images (checksum text,data blob)')
                db.execute('insert into chapters values (?,?,?,?,?)', (*key, body, digest(body + references.encode()), references))
                db.execute('insert into images values (?,?)', (digest(image), image))
            previous = legacy.read_bytes()
            adapter = Mock()
            adapter.get_chapters.return_value = [{'url': 'chapter'}]
            adapter.normalize_chapterurl.side_effect = lambda url: url
            adapter.story.img_store.add_img.return_value = {'newsrc': 'images/restored.webp'}
            with recover_chapters(adapter, directory, 'story', Mock(failure=None)) as downloaded:
                self.assertIn('images/restored.webp', adapter.getChapterTextNum('chapter', 0))
                self.assertEqual(downloaded(), 0)
            adapter.getChapterTextNum.assert_not_called()
            self.assertEqual(legacy.read_bytes(), previous)
            legacy.unlink()
            with recover_chapters(adapter, directory, 'story', Mock(failure=None)):
                self.assertIn('images/restored.webp', adapter.getChapterTextNum('chapter', 0))
            store = ChapterCheckpoint(directory)
            self.assertFalse(store.load(key)[2])
            self.assertEqual(store.image(digest(image)), image)
            store.close()

    def test_images_are_deduplicated_and_failed_publication_preserves_prior_record(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ChapterCheckpoint(directory)
            key = (digest(b'story'), digest(b'chapter'))
            checksum = store.put_image(b'illustration')
            store.put_image(b'illustration')
            self.assertEqual(len(list(Path(directory, 'v2', 'images').glob('*/*'))), 1)
            store.save(key, zlib.compress(b'old'), '[]')
            with patch('chapter_checkpoint.os.replace', side_effect=OSError(28, 'No space left')):
                with self.assertRaises(OSError):
                    store.save(key, zlib.compress(b'new'), '[]')
            self.assertEqual(zlib.decompress(store.load(key)[0]), b'old')
            self.assertEqual(store.image(checksum), b'illustration')
            self.assertFalse(list(store.record_path(key).parent.glob('.checkpoint-*')))
            store.close()

    @unittest.skipUnless(sys.platform == 'linux', 'Linux worker file-size limits')
    def test_aggregate_illustrations_can_exceed_the_worker_single_file_limit(self):
        code = '''
from pathlib import Path
import resource,sys
from chapter_checkpoint import ChapterCheckpoint,digest
resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
store=ChapterCheckpoint(sys.argv[1])
for n in range(40):
 data=n.to_bytes(4,'big')+b'x'*8192
 store.put_image(data)
store.save((digest(b'story'),digest(b'chapter')),b'body','[]')
assert sum(p.stat().st_size for p in Path(sys.argv[1]).rglob('*') if p.is_file())>65536
store.close()
'''
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run([sys.executable, '-c', code, directory], cwd=Path(__file__).parent, check=True)


if __name__ == '__main__':
    unittest.main()
