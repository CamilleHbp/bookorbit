import tempfile
import unittest

from fanficfare.epubutils import make_soup

from story_spool import StorySpool


class StorySpoolTest(unittest.TestCase):
    def test_interleaved_images_and_markup_remain_readable_after_more_writes(self):
        with tempfile.TemporaryFile() as file:
            spool = StorySpool(file)
            image = spool.image_info({'data': b'illustration', 'mime': 'image/webp'})
            saved = spool.body(make_soup('<html><body><p>One &amp; two</p></body></html>').body)
            size = file.tell()
            self.assertEqual(image['data'], b'illustration')
            self.assertEqual(spool.image(b'illustration')(), image['data'])
            self.assertEqual(file.seek(0, 2), size)
            spool.image(b'next picture')
            self.assertEqual(saved().p.get_text(), 'One & two')
            self.assertEqual(image.get('data'), b'illustration')
