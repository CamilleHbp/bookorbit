import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZIP_STORED

from chapter_locks import preserve_chapter_locks, LOCK, elements, chapter_metadata, chapters
from chapter_lock_merge import BASELINE, ChapterLockConflict, baseline_data, merge_additions
from publisher_edition import parse
from safe_transport import PolicyError

URL = 'https://example.org/chapter/1'


def chapter(text, url=URL, locked=False, baseline=False):
    return ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title>'
            '<meta name="chapterurl" content="' + url + '"/>' +
            ('<meta name="' + LOCK + '" content="true"/>' if locked else '') +
            ('<meta name="' + BASELINE + '" content="baseline.json"/>' if baseline else '') +
            '<link rel="stylesheet" href="style.css"/></head><body><div class="chp_raw">' + text + '</div></body></html>').encode()


def epub(path, docs, assets=None):
    assets = assets or {}
    items = ''.join('<item id="c' + str(i) + '" href="' + name + '" media-type="application/xhtml+xml"/>' for i, name in enumerate(docs))
    items += '<item id="css" href="style.css" media-type="text/css"/>'
    items += ''.join('<item id="a' + str(i) + '" href="' + name + '" media-type="application/octet-stream"/>' for i, name in enumerate(assets))
    spine = ''.join('<itemref idref="c' + str(i) + '"/>' for i in range(len(docs)))
    with ZipFile(path, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip', compress_type=ZIP_STORED)
        z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
        z.writestr('OPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>' + items + '</manifest><spine>' + spine + '</spine></package>')
        z.writestr('OPS/style.css', 'p {color: blue}')
        for name, data in {**docs, **assets}.items():
            z.writestr('OPS/' + name, data)


class ChapterLocksTest(unittest.TestCase):
    def test_legacy_unlocked_body_does_not_block_a_valid_replacement_or_hide_a_lock(self):
        from xml.parsers.expat import ExpatError
        from fanficfare_wrapper import failure_code
        with tempfile.TemporaryDirectory() as directory:
            old, new = [Path(directory)/n for n in ('old.epub', 'new.epub')]
            for locked in (False, True):
                epub(old, {'one.xhtml': chapter('<p>Legacy unescaped < text</p>', locked=locked)})
                epub(new, {'one.xhtml': chapter('<p>Valid website chapter</p>')})
                before = new.read_bytes()
                if locked:
                    with self.assertRaises(ExpatError) as raised:
                        preserve_chapter_locks(old, new)
                    self.assertEqual(failure_code(raised.exception), 'invalid_epub')
                else:
                    self.assertEqual(preserve_chapter_locks(old, new), 0)
                self.assertEqual(new.read_bytes(), before)
            with ZipFile(old) as archive, self.assertRaises(ExpatError):
                chapters(archive)

    def test_header_reader_rejects_malformed_xml_and_entities_and_ignores_body_metadata(self):
        from xml.parsers.expat import ExpatError
        self.assertEqual(chapter_metadata(chapter('<meta name="' + LOCK + '" content="true"/>'))['chapterurl'], URL)
        self.assertNotIn(LOCK, chapter_metadata(chapter('<meta name="' + LOCK + '" content="true"/>')))
        with self.assertRaises(ExpatError):
            chapter_metadata(chapter('Body').replace(b'<title>', b'<title broken="'))
        for declaration in (b'<!DOCTYPE html>', b'<!DOCTYPE html [<!ENTITY private SYSTEM "file:///private">]>'):
            with self.assertRaises(PolicyError):
                chapter_metadata(declaration + chapter('Body'))

    def test_real_update_replaces_malformed_unlocked_legacy_xhtml_without_modifying_the_input(self):
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        from fanficfare_wrapper import run
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory, patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'getChapterText', return_value='<p>Website chapter.</p>'):
            try:
                os.chdir(directory)
                request = {'operation': 'download', 'url': 'https://test1.com/?sid=1', 'configuration': ''}
                run(request)
                with ZipFile('output.epub') as source, ZipFile('input.epub', 'w') as old:
                    target = next(n for n in source.namelist() if n.endswith('.xhtml') and b'name="chapterurl"' in source.read(n))
                    for info in source.infolist():
                        data = source.read(info.filename)
                        if info.filename == target:
                            data = data.replace(b'Website chapter.', b'Legacy unescaped < text.')
                        old.writestr(info, data)
                Path('output.epub').unlink()
                original = Path('input.epub').read_bytes()
                result = run({**request, 'operation': 'update', 'checkStatePath': str(Path(directory)/'state.json')})
                self.assertEqual(result['output'], 'output.epub')
                self.assertEqual(Path('input.epub').read_bytes(), original)
                with ZipFile('output.epub') as output:
                    parse(output.read(target))
                    self.assertIn(b'Website chapter.', output.read(target))
            finally:
                os.chdir(cwd)

    def test_repeated_passages_use_unique_anchors_and_reject_ambiguous_positions(self):
        def body(text):return elements(parse(chapter(text)), 'body')[0]
        baseline=body('<p>Opening</p><p>Repeated</p><p>Repeated</p><p>Ending</p>')
        local=body('<p>Opening</p><p>Local replacement</p><p>Repeated</p><p>Ending</p>')
        resolver=lambda path:path
        for text in ('<p>Opening</p><p>Repeated</p><p>Added</p><p>Repeated</p><p>Ending</p>',
                     '<p>Opening</p><p>Repeated plus</p><p>Repeated</p><p>Ending</p>'):
            with self.assertRaises(ChapterLockConflict):
                merge_additions(baseline, local, body(text), resolver, resolver, resolver)
        fresh=body('<p>Opening</p><p>Added</p><p>Repeated</p><p>Repeated</p><p>Ending</p>')
        text=merge_additions(baseline, local, fresh, resolver, resolver, resolver).toxml()
        self.assertLess(text.index('Added'),text.index('Local replacement'))

    def test_real_runtime_preserves_edits_and_merges_additions_on_update_and_refresh(self):
        from fanficfare.adapters.adapter_test1 import TestSiteAdapter
        from fanficfare_wrapper import run
        current = ['<p>Original chapter.</p><p>Ending.</p>']
        def text(adapter, url):
            return adapter.utf8FromSoup(url, adapter.make_soup(current[0]))
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory, patch.object(TestSiteAdapter, 'getSiteURLPattern', return_value=r'^https?://test1\.com/?\?sid=\d+$'), patch.object(TestSiteAdapter, 'getChapterText', autospec=True, side_effect=text):
            try:
                os.chdir(directory)
                request = {'operation':'download', 'url':'https://test1.com/?sid=1', 'configuration':''}
                run(request)
                with ZipFile('output.epub') as original, ZipFile('input.epub','w') as edited:
                    target = next(n for n in original.namelist() if n.endswith('.xhtml') and b'name="chapterurl"' in original.read(n))
                    baseline = baseline_data(original, target, original.read(target), parse)
                    baseline_path = str(Path(target).parent/'baseline.json')
                    for info in original.infolist():
                        data = original.read(info.filename)
                        if info.filename == target:
                            doc = parse(data.replace(b'Original chapter.', b'Local edit.'))
                            head = elements(doc,'head')[0]
                            for key,value in ((LOCK,'true'),(BASELINE,'baseline.json')):
                                meta=doc.createElement('meta');meta.setAttribute('name',key);meta.setAttribute('content',value);head.appendChild(meta)
                            data=doc.toxml(encoding='utf-8')
                        edited.writestr(info,data)
                    edited.writestr(baseline_path,baseline)
                Path('output.epub').unlink()
                for operation in ('update','refresh'):
                    current[0] = '<p>Before.</p><p>Original chapter.</p><p>Ending.</p>' + ('<p>After.</p>' if operation == 'refresh' else '')
                    result = run({**request,'operation':operation,'checkStatePath':str(Path(directory)/'state.json')})
                    self.assertEqual(result['output'],'output.epub')
                    with ZipFile('output.epub') as z:
                        data=z.read(target)
                        self.assertIn(b'Local edit.',data)
                        self.assertIn(b'Before.',data)
                        if operation == 'refresh':self.assertIn(b'After.',data)
                    Path('output.epub').replace('input.epub')
            finally:
                os.chdir(cwd)

    def test_lock_preserves_local_content_and_assets_across_renaming_and_repeated_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            old, new = [Path(directory)/n for n in ('old.epub', 'new.epub')]
            epub(old, {'one.xhtml': chapter('<p>Local edit</p><img src="picture.webp"/>', locked=True)}, {'picture.webp': b'local image'})
            epub(new, {'renamed.xhtml': chapter('<p>Website rewrite</p>'), 'two.xhtml': chapter('<p>New chapter</p>', URL+'2')}, {'picture.webp': b'different image'})
            for _ in range(2):
                self.assertEqual(preserve_chapter_locks(old, new), 1)
                with ZipFile(new) as z:
                    text=z.read('OPS/renamed.xhtml')
                    self.assertIn(b'Local edit', text)
                    self.assertNotIn(b'Website rewrite', text)
                    self.assertIn(LOCK.encode(), text)
                    self.assertIn(b'New chapter', z.read('OPS/two.xhtml'))
                    doc=parse(text)
                    src=elements(doc, 'img')[0].getAttribute('src')
                    self.assertEqual(z.read('OPS/'+src), b'local image')
                old.write_bytes(new.read_bytes())

    def test_baseline_merges_additions_at_their_anchors_without_losing_local_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            original, local, website = [Path(directory)/n for n in ('original.epub', 'local.epub', 'website.epub')]
            baseline='<p>Opening.</p><p>Original panel</p><p>Ending.</p>'
            epub(original, {'one.xhtml': chapter(baseline)})
            with ZipFile(original) as z:
                data=baseline_data(z, 'OPS/one.xhtml', z.read('OPS/one.xhtml'), parse)
            epub(local, {'one.xhtml': chapter('<p>Opening.</p><div>Readable local panel</div><p>Ending.</p>', locked=True, baseline=True)}, {'baseline.json': data})
            fresh='<p>New opening.</p><p>Opening.</p><p>Before panel.</p><img src="new.webp"/><p>Original panel</p><p>After panel.</p><p>Ending. More.</p><p>New ending.</p>'
            epub(website, {'renamed.xhtml': chapter(fresh), 'two.xhtml': chapter('<p>Second</p>', URL+'2')}, {'new.webp': b'new illustration'})
            preserve_chapter_locks(local, website)
            with ZipFile(website) as z:
                text=z.read('OPS/renamed.xhtml').decode()
                for value in ('New opening.', 'Before panel.', 'Readable local panel', 'After panel.', 'Ending. More.', 'New ending.'):
                    self.assertIn(value, text)
                self.assertNotIn('Original panel', text)
                self.assertLess(text.index('Before panel.'), text.index('Readable local panel'))
                self.assertLess(text.index('Readable local panel'), text.index('After panel.'))
                self.assertEqual(z.read('OPS/new.webp'), b'new illustration')
                self.assertIn('src="new.webp"', text)
            # A subsequent refresh keeps those additions and accepts another insertion.
            local.write_bytes(website.read_bytes())
            epub(website, {'one.xhtml': chapter(fresh+'<p>Another addition.</p>')}, {'new.webp': b'new illustration'})
            preserve_chapter_locks(local, website)
            with ZipFile(website) as z:
                text=z.read('OPS/one.xhtml')
                self.assertIn(b'Another addition.', text)
                self.assertIn(b'Readable local panel', text)

    def test_source_edits_or_deletions_require_review_and_leave_output_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            original, local, website = [Path(directory)/n for n in ('original.epub', 'local.epub', 'website.epub')]
            epub(original, {'one.xhtml': chapter('<p>Original</p><p>Ending</p>')})
            with ZipFile(original) as z:
                data=baseline_data(z, 'OPS/one.xhtml', z.read('OPS/one.xhtml'), parse)
            epub(local, {'one.xhtml': chapter('<p>Edited locally</p><p>Ending</p>', locked=True, baseline=True)}, {'baseline.json': data})
            for body in ('<p>Rewritten upstream</p><p>Ending</p>', '<p>Ending</p>'):
                epub(website, {'one.xhtml': chapter(body)})
                before=website.read_bytes()
                with self.assertRaises(PolicyError):
                    preserve_chapter_locks(local, website)
                self.assertEqual(before, website.read_bytes())

    def test_unlocked_books_are_byte_identical_and_removed_locked_chapters_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            old, new = [Path(directory)/n for n in ('old.epub', 'new.epub')]
            epub(old, {'one.xhtml': chapter('<p>Old</p>')})
            epub(new, {'one.xhtml': chapter('<p>New</p>')})
            before=new.read_bytes()
            self.assertEqual(preserve_chapter_locks(old, new), 0)
            self.assertEqual(before, new.read_bytes())
            epub(old, {'one.xhtml': chapter('<p>Local</p>', locked=True)})
            epub(new, {'two.xhtml': chapter('<p>Other chapter</p>', URL+'2')})
            before=new.read_bytes()
            with self.assertRaises(PolicyError):
                preserve_chapter_locks(old, new)
            self.assertEqual(before, new.read_bytes())


if __name__ == '__main__':
    unittest.main()
