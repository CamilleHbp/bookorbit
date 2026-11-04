"""Apply the account's approved vocabulary before writing EPUB subjects."""
import unicodedata


def key(value):
    return ' '.join(unicodedata.normalize('NFC', value).split()).lower()


BROAD = {'m/m', 'f/f', 'f/m', 'm/f', 'male/male', 'female/female',
         'female/male', 'male/female', 'gen', 'multi', 'other'}


def resolve(source, labels, rules):
    general, specific = {}, {}
    for rule in rules:
        index = (rule['field'], key(rule['value']))
        if rule['source'] is None:
            general[index] = rule
        elif rule['source'] == source:
            specific[index] = rule
    blocked = {key(item['value']) for item in labels if item['field'] == 'characters'
               or (item['field'] == 'relationships' and key(item['value']) not in BROAD)}
    targets, pending, categories = {}, set(), {'fandoms': [], 'characters': [], 'relationships': [], 'warnings': [], 'rating': ''}
    for item in labels:
        field, value = item['field'], key(item['value'])
        if not value:
            continue
        if field == 'characters' or (field == 'relationships' and value not in BROAD) or (field in ('tags', 'genres') and value in blocked):
            continue
        rule = specific.get((field, value), general.get((field, value)))
        if rule is None or rule.get('unresolved'):
            pending.add((field, value))
            continue
        for target in rule['targets']:
            targets[(target['field'], target['name'])] = target
            if field in ('fandoms', 'relationships', 'warnings') and target['name'] not in categories[field]:
                categories[field].append(target['name'])
            if field == 'rating':
                categories['rating'] = target['name']
    return {'tags': [t['name'] for t in targets.values() if t['field'] == 'tags'],
            'genres': [t['name'] for t in targets.values() if t['field'] == 'genres'],
            'categories': categories, 'pendingLabelCount': len(pending)}


def install(story, source, policy):
    original = story.getSubjectTags
    def snapshot():
        labels = [{'field': 'tags', 'value': value} for value in original()]
        for field, name in [('genres', 'genre'), ('fandoms', 'category'), ('characters', 'characters'), ('relationships', 'ships'), ('warnings', 'warnings')]:
            labels.extend({'field': field, 'value': value} for value in story.getList(name))
        rating = story.getMetadata('rating')
        if rating:
            labels.append({'field': 'rating', 'value': rating})
        return {**resolve(source, labels, policy['rules']), 'rawLabels': labels, 'labelMappingVersion': policy['version']}
    def subjects(*args, **kwargs):
        resolved = snapshot()
        return list(dict.fromkeys(resolved['tags'] + resolved['genres']))
    story.getSubjectTags = subjects
    story.bookorbit_matched_labels = snapshot


def matched_preview(story, preview):
    snapshot = getattr(story, 'bookorbit_matched_labels', None)
    return {**preview, **snapshot()} if snapshot else preview
