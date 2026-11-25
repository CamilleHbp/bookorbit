import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch
from xml.dom import minidom
from zipfile import ZipFile

from chapter_floor import MARKER, apply_policy, read_policy, validate_policy, validate_output
from publisher_edition import package, OPF, DC
from safe_transport import PolicyError

URL = 'https://www.royalroad.com/fiction/83294'


def policy(minimum=None, extras=None):
    return {'version': 1, 'storyUrl': URL, 'minimum': minimum or [88], 'extraChapterUrls': extras or []}


def chapter(title, number):
    return {'title': title, 'url': URL + '/story/chapter/' + str(number) + '/slug'}


def stamp(path, value, lock=False):
    with ZipFile(path) as archive:
        name, doc = package(archive)
        metadata = doc.getElementsByTagNameNS(OPF, 'metadata')[0]
        for key, content in [(MARKER, json.dumps(value)), ('calibre:series', 'Continuation series'), ('calibre:series_index', '6')]:
            node = doc.createElementNS(OPF, 'meta'); node.setAttribute('name', key); node.setAttribute('content', content); metadata.appendChild(node)
        title = doc.getElementsByTagNameNS(DC, 'title')[0]
        title.firstChild.data = 'Web Continuation'
        updated = {name: doc.toxml(encoding='utf-8')}
        if lock:
            for name in archive.namelist():
                if not name.endswith('.xhtml') or b'chapterurl' not in archive.read(name): continue
                local = minidom.parseString(archive.read(name))
                marker = local.createElement('meta'); marker.setAttribute('name', 'bookorbit:chapter-lock'); marker.setAttribute('content', 'true')
                local.getElementsByTagName('head')[0].appendChild(marker)
                updated[name] = local.toxml(encoding='utf-8').replace(b'Source chapter', b'Locally edited chapter')
                break
        entries = [(entry, updated.get(entry.filename, archive.read(entry.filename))) for entry in archive.infolist()]
    with ZipFile(path, 'w') as archive:
        for entry, data in entries: archive.writestr(entry, data)


class ChapterFloorTests(unittest.TestCase):
    def test_scribblehub_main_and_side_cutoffs_use_source_titles(self):
        url = 'https://www.scribblehub.com/series/623932/on-astral-tides/'
        def entry(title, n):
            return {'title': 'Chapter ' + str(n), 'site_title': title,
                    'url': f'https://www.scribblehub.com/read/623932-on-astral-tides/chapter/{n}/'}
        entries = [entry('Five Hundred And Twenty-Four', 1), entry('Side One Hundred And Seventy-Five - Aiko', 2),
                   entry('Five Hundred And Twenty-Five - Contains Status', 3),
                   entry('Side One Hundred And Seventy-Six - Aiko', 4), entry('Chapter 526 - Next', 5),
                   entry('Announcement', 6), entry('Bonus scene', 7), entry('One - Restored', 8)]
        cutoff = {'version': 1, 'storyUrl': url, 'minimum': [525, 176], 'extraChapterUrls': [entries[6]['url']]}
        validate_policy(cutoff)
        adapter = Mock(); adapter.get_chapters.return_value = entries
        apply_policy(adapter, cutoff, url)
        self.assertEqual(adapter.chapterInfos, entries[2:5] + [entries[6]])
        with self.assertRaises(PolicyError): validate_policy({**cutoff, 'minimum': [525]})
        with self.assertRaises(PolicyError): validate_policy({**cutoff, 'extraChapterUrls': [chapter('', 1)['url']]})
        with self.assertRaises(PolicyError): apply_policy(adapter, cutoff, url.replace('623932', '999'))

    def test_scribblehub_updates_and_refreshes_keep_published_chapters_out(self):
        from fanficfare.adapters.adapter_scribblehubcom import ScribbleHubComAdapter
        from fanficfare_wrapper import run
        url = 'https://www.scribblehub.com/series/623932/on-astral-tides/'
        def entry(title, n):
            return {'title': title, 'url': f'https://www.scribblehub.com/read/623932-on-astral-tides/chapter/{n}/'}
        available = [entry('Five Hundred And Twenty-Five', 525), entry('Side One Hundred And Seventy-Six - Aiko', 176)]
        cutoff = {'version': 1, 'storyUrl': url, 'minimum': [525, 176], 'extraChapterUrls': []}
        original = os.getcwd()
        def metadata(adapter):
            adapter.story.setMetadata('title', 'Source title')
            adapter.story.addToList('author', 'Author')
            adapter.story.addToList('authorId', '1')
            adapter.story.addToList('authorUrl', 'https://www.scribblehub.com/profile/1')
            adapter.story.setMetadata('datePublished', datetime(2024, 1, 1))
            adapter.story.setMetadata('dateUpdated', datetime(2026, 1, 1))
            for c in available: adapter.add_chapter(c['title'], c['url'])
        def text(adapter, chapter_url):
            return adapter.utf8FromSoup(chapter_url, adapter.make_soup('<p>Source chapter '+chapter_url+'</p>'))
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                request = {'operation': 'download', 'url': url, 'configuration': '[defaults]\nuse_flaresolverr_proxy:false\n',
                           'checkStatePath': str(Path(directory)/'check.json')}
                with patch.object(ScribbleHubComAdapter, 'extractChapterUrlsAndMetadata', autospec=True, side_effect=metadata), patch.object(ScribbleHubComAdapter, 'getChapterText', autospec=True, side_effect=text) as fetched:
                    run(request)
                    Path('output.epub').replace('input.epub')
                    stamp('input.epub', cutoff)
                    available[:0] = [entry('One', 1), entry('Five Hundred And Twenty-Four', 524),
                                     entry('Side One Hundred And Seventy-Five - Aiko', 175)]
                    available.append(entry('Five Hundred And Twenty-Six', 526))
                    available.append(entry('Side One Hundred And Seventy-Seven - Aiko', 177))
                    available[3], available[4] = available[4], available[3]
                    expected = available[3:]
                    for operation in ('update', 'refresh'):
                        request['operation'] = operation
                        fetched.reset_mock()
                        self.assertEqual(run(request)['preview']['chapterCount'], 4)
                        self.assertEqual({call.args[1] for call in fetched.call_args_list}, {c['url'] for c in (expected[2:] if operation == 'update' else expected)})
                        self.assertEqual(read_policy('output.epub'), cutoff)
                        validate_output('output.epub', expected)
                        Path('output.epub').replace('input.epub')
                    request['operation'] = 'update'
                    fetched.reset_mock()
                    self.assertEqual(run(request)['output'], 'input.epub')
                    fetched.assert_not_called()
            finally:
                os.chdir(original)

    def test_single_and_arc_cutoffs_exclude_restored_and_reordered_early_chapters(self):
        for minimum, titles in [([88], ['Chapter 87 - Covered', 'Chapter 88 - First', 'Chapter 100 - Part II']),
                                ([10, 20], ['10-19 Covered', '10-20 First', '11-1 Next arc'])]:
            adapter = Mock()
            adapter.get_chapters.return_value = [chapter(t, i+1) for i, t in enumerate(titles)] + [chapter('Announcement', 4)]
            apply_policy(adapter, policy(minimum), URL)
            self.assertEqual([c['title'] for c in adapter.chapterInfos], titles[1:])
            adapter.story.setMetadata.assert_called_with('numChapters', 2)

    def test_bonus_allowlist_cannot_override_numeric_cutoff(self):
        adapter = Mock()
        adapter.get_chapters.return_value = [chapter('Chapter 1 - Covered', 1), chapter('Bonus', 2), chapter('Unrelated announcement', 3)]
        apply_policy(adapter, policy(extras=[chapter('', 1)['url'], chapter('', 2)['url']]), URL)
        self.assertEqual([c['title'] for c in adapter.chapterInfos], ['Bonus'])

    def test_invalid_cutoff_or_wrong_story_stops_update(self):
        for value in [{}, {**policy(), 'version': 2}, policy([True]), policy([-1]), policy([1, 2, 3]),
                      {**policy(), 'extraChapterUrls': ['https://evil.example/chapter/1']},
                      {**policy(), 'extraChapterUrls': ['https://www.royalroad.com/fiction/999/chapter/1']}]:
            with self.assertRaises(PolicyError): validate_policy(value)
        adapter = Mock(); adapter.get_chapters.return_value = [chapter('Chapter 1 - Covered', 1)]
        with self.assertRaises(PolicyError): apply_policy(adapter, policy(), URL)
        with self.assertRaises(PolicyError): apply_policy(adapter, policy(), 'https://www.royalroad.com/fiction/999')

    def test_real_updates_refreshes_and_fast_checks_keep_cutoff_and_local_locks(self):
        from fanficfare.adapters.adapter_royalroadcom import RoyalRoadAdapter
        from fanficfare_wrapper import run
        original = os.getcwd()
        available = [chapter('Chapter 88 - First', 88), chapter('Chapter 89 - Second', 89)]

        def metadata(adapter):
            adapter.story.setMetadata('title', 'Original source title')
            adapter.story.addToList('author', 'Author')
            adapter.story.addToList('authorId', '1')
            adapter.story.addToList('authorUrl', 'https://www.royalroad.com/profile/1')
            adapter.story.setMetadata('datePublished', datetime(2024, 1, 1))
            adapter.story.setMetadata('dateUpdated', datetime(2026, 1, 1))
            for c in available: adapter.add_chapter(c['title'], c['url'])

        def text(adapter, url):
            return adapter.utf8FromSoup(url, adapter.make_soup('<p>Source chapter '+url+'</p>'))

        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                request = {'operation': 'download', 'url': URL, 'configuration': '', 'checkStatePath': str(Path(directory)/'check.json')}
                with patch.object(RoyalRoadAdapter, 'extractChapterUrlsAndMetadata', autospec=True, side_effect=metadata), patch.object(RoyalRoadAdapter, 'getChapterText', autospec=True, side_effect=text) as fetched:
                    run(request)
                    Path('output.epub').replace('input.epub')
                    self.assertIsNone(read_policy('input.epub'))
                    with self.assertRaises(PolicyError): validate_output('input.epub', [available[1]])
                    stamp('input.epub', policy(), lock=True)
                    available[:0] = [chapter('Chapter 1 - Restored beginning', 1), chapter('Chapter 87 - Covered', 87), chapter('Promotion', 4)]
                    available.append(chapter('Chapter 90 - New', 90))
                    request['operation'] = 'update'
                    fetched.reset_mock()
                    result = run(request)
                    self.assertEqual(result['preview']['chapterCount'], 3)
                    self.assertEqual({call.args[1] for call in fetched.call_args_list}, {c['url'] for c in available if c['title'].startswith('Chapter 90')})
                    self.assertTrue(all('/chapter/1/' not in call.args[1] and '/chapter/87/' not in call.args[1] and '/chapter/4/' not in call.args[1] for call in fetched.call_args_list))
                    def assert_output():
                        self.assertEqual(read_policy('output.epub'), policy())
                        with ZipFile('output.epub') as archive:
                            _, doc = package(archive)
                            self.assertEqual(doc.getElementsByTagNameNS(DC, 'title')[0].firstChild.data, 'Web Continuation')
                            content = b''.join(archive.read(n) for n in archive.namelist() if n.endswith('.xhtml'))
                            self.assertIn(b'Locally edited chapter', content)
                            self.assertNotIn(b'Restored beginning', content)
                    assert_output()
                    Path('output.epub').replace('input.epub')
                    fetched.reset_mock()
                    self.assertEqual(run(request)['output'], 'input.epub')
                    fetched.assert_not_called()
                    request['operation'] = 'refresh'
                    fetched.reset_mock()
                    run(request)
                    self.assertEqual({call.args[1] for call in fetched.call_args_list}, {c['url'] for c in available if c['title'].startswith(('Chapter 88', 'Chapter 89', 'Chapter 90'))})
                    assert_output()
            finally:
                os.chdir(original)


if __name__ == '__main__': unittest.main()
