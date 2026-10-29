from safe_transport import ConfigurationError


def apply_tag_rules(story, rules):
    if not isinstance(rules, list) or len(rules) > 100:
        raise ConfigurationError('Invalid tag rules')
    replacements = {}
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) != {'remoteTag', 'targetTag'}:
            raise ConfigurationError('Invalid tag rule')
        for value in rule.values():
            if not isinstance(value, str) or not value.strip() or len(value) > 500:
                raise ConfigurationError('Invalid tag rule value')
        key = rule['remoteTag'].strip().lower()
        if key in replacements:
            raise ConfigurationError('Duplicate remote tag rule')
        replacements[key] = rule['targetTag'].strip()
    original = story.getSubjectTags

    # Keep preview metadata and EPUB subjects identical, including after chapter downloads.
    def mapped_subjects(*args, **kwargs):
        result = []
        seen = set()
        for tag in original(*args, **kwargs):
            value = replacements.get(tag.strip().lower(), tag)
            if value.lower() not in seen:
                result.append(value)
                seen.add(value.lower())
        return result
    if rules:
        story.getSubjectTags = mapped_subjects
