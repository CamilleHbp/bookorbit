import unittest
from unittest.mock import Mock
from tag_rules import apply_tag_rules
from safe_transport import PolicyError


class TagRulesTest(unittest.TestCase):
    def test_matches_whole_tags_ignoring_case_without_chaining(self):
        story = Mock(getSubjectTags=Mock(return_value=[' Remote ', 'REMOTE', 'Other', 'Remote extra']))
        apply_tag_rules(story, [{'remoteTag': 'remote', 'targetTag': 'Fantasy'}, {'remoteTag': 'Fantasy', 'targetTag': 'Other'}])
        self.assertEqual(story.getSubjectTags(), ['Fantasy', 'Other', 'Remote extra'])

    def test_subjects_remain_dynamic_after_metadata_changes(self):
        from fanficfare.configurable import Configuration
        from fanficfare.story import Story
        config = Configuration(['defaults'], 'epub')
        config.read_string('[defaults]\ninclude_subject_tags: genre\n')
        story = Story(config)
        story.addToList('genre', 'Remote')
        apply_tag_rules(story, [{'remoteTag': 'Remote', 'targetTag': 'Fantasy'}])
        self.assertEqual(story.getSubjectTags(), ['Fantasy'])
        story.addToList('genre', 'Adventure')
        self.assertEqual(set(story.getSubjectTags()), {'Fantasy', 'Adventure'})

    def test_preserves_existing_profiles_without_rules(self):
        story = Mock(getSubjectTags=Mock(return_value=['A', 'a']))
        apply_tag_rules(story, [])
        self.assertEqual(story.getSubjectTags(), ['A', 'a'])

    def test_rejects_invalid_and_duplicate_rules(self):
        for rules in [None, [{}], [{'remoteTag': '', 'targetTag': 'A'}], [{'remoteTag': 'a', 'targetTag': 'b'}] * 101,
                      [{'remoteTag': 'A', 'targetTag': 'B'}, {'remoteTag': ' a ', 'targetTag': 'C'}]]:
            with self.subTest(rules=rules), self.assertRaises(PolicyError):
                apply_tag_rules(Mock(), rules)
