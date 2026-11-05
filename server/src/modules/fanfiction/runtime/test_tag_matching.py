import unittest
from tag_matching import resolve, install, matched_preview


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.rules = [
            {'source': None, 'field': 'tags', 'value': 'old', 'targets': [{'field': 'tags', 'name': 'canonical'}]},
            {'source': None, 'field': 'fandoms', 'value': 'A', 'targets': [{'field': 'tags', 'name': 'fandom.a'}]},
            {'source': None, 'field': 'fandoms', 'value': 'B', 'targets': [{'field': 'tags', 'name': 'fandom.b'}]},
        ]

    def test_original_work_fandom_needs_no_review(self):
        labels = [{'field': 'fandoms', 'value': ' Original Work '}, {'field': 'characters', 'value': 'Original Character'}]
        result = resolve('ao3', labels, self.rules)
        self.assertEqual(result['pendingLabelCount'], 0)
        self.assertEqual(result['tags'], [])
        approved = {'source': None, 'field': 'fandoms', 'value': 'Original Work', 'targets': [{'field': 'tags', 'name': 'original'}]}
        self.assertEqual(resolve('ao3', labels, self.rules + [approved])['tags'], ['original'])

    def test_matching_and_unknowns(self):
        result = resolve('ao3', [{'field': 'tags', 'value': ' OLD '}, {'field': 'genres', 'value': 'old'}], self.rules)
        self.assertEqual(result['tags'], ['canonical'])
        self.assertEqual(result['genres'], [])
        self.assertEqual(result['pendingLabelCount'], 0)

    def test_ignore_and_deleted_override(self):
        labels = [{'field': 'tags', 'value': 'old'}]
        override = {'source': 'ao3', 'field': 'tags', 'value': 'old', 'targets': []}
        self.assertEqual(resolve('ao3', labels, self.rules + [override])['pendingLabelCount'], 0)
        self.assertEqual(resolve('ao3', labels, self.rules + [{**override, 'unresolved': True}])['pendingLabelCount'], 1)

    def test_names_removed_across_fields_and_crossovers_preserved(self):
        labels = [{'field': field, 'value': value} for field, value in [
            ('characters', 'Alice'), ('tags', 'Alice'), ('relationships', 'Alice/Bob'),
            ('genres', 'Alice/Bob'), ('fandoms', 'A'), ('fandoms', 'B')]]
        result = resolve('ao3', labels, self.rules)
        self.assertEqual(result['tags'], ['fandom.a', 'fandom.b'])
        self.assertEqual(result['categories']['characters'], [])
        self.assertEqual(result['categories']['relationships'], [])
        self.assertEqual(result['pendingLabelCount'], 0)

    def test_character_rules_produce_only_canonical_fandoms(self):
        labels = [{'field': 'characters', 'value': 'Alice (A)'}, {'field': 'tags', 'value': 'Alice (A)'}]
        rule = {'source': None, 'field': 'characters', 'value': 'Alice (A)', 'targets': [
            {'field': 'tags', 'name': 'fandom.a'}, {'field': 'tags', 'name': 'Alice'}, {'field': 'genres', 'name': 'Character'}]}
        result = resolve('ao3', labels, [rule])
        self.assertEqual(result['tags'], ['fandom.a'])
        self.assertEqual(result['genres'], [])
        self.assertEqual(result['categories']['fandoms'], ['fandom.a'])
        self.assertEqual(result['categories']['characters'], [])
        self.assertEqual(resolve('ao3', labels, [rule, {**rule, 'source': 'ao3', 'targets': []}])['tags'], [])

    def test_writer_omits_genre_destinations_and_keeps_approved_tags(self):
        class Story:
            def getSubjectTags(self): return ['source genre']
            def getList(self, name): return []
            def getMetadata(self, name): return ''
        story = Story()
        install(story, 'ao3', {'version': 3, 'rules': [
            {'source': None, 'field': 'tags', 'value': 'source genre', 'targets': [
                {'field': 'tags', 'name': 'approved.tag'}, {'field': 'genres', 'name': 'Approved genre'}]},
        ]})
        self.assertEqual(story.getSubjectTags(), ['approved.tag'])
        preview = matched_preview(story, {})
        self.assertEqual(preview['tags'], ['approved.tag'])
        self.assertEqual(preview['genres'], [])

    def test_writer_and_preview_share_final_subjects_after_metadata_changes(self):
        class Story:
            subjects = ['old', 'Alice']
            def getSubjectTags(self): return self.subjects
            def getList(self, name): return {'characters': ['Alice'], 'category': ['A']}.get(name, [])
            def getMetadata(self, name): return ''
        story = Story()
        install(story, 'ao3', {'version': 2, 'rules': self.rules})
        self.assertEqual(story.getSubjectTags(), ['canonical', 'fandom.a'])
        story.subjects = ['new unknown', 'Alice']
        preview = matched_preview(story, {'title': 'Story'})
        self.assertEqual(preview['tags'], story.getSubjectTags())
        self.assertEqual(preview['tags'], ['fandom.a'])
        self.assertEqual(preview['labelMappingVersion'], 2)
        self.assertEqual(preview['pendingLabelCount'], 1)
        self.assertTrue(any(label['value'] == 'Alice' for label in preview['rawLabels']))


if __name__ == '__main__':
    unittest.main()
