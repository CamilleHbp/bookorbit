"""Three-way insertion merging for local chapter edits."""
from difflib import SequenceMatcher
import json
import posixpath
from urllib.parse import unquote, urlsplit

from safe_transport import PolicyError

BASELINE = 'bookorbit:chapter-baseline'


class ChapterLockConflict(PolicyError):
    code = 'chapter_lock_conflict'


def children(node):
    return [n for n in node.childNodes if n.nodeType != n.COMMENT_NODE and
            (n.nodeType not in (n.TEXT_NODE, n.CDATA_SECTION_NODE) or n.data.strip())]


def node_key(node, resource_hash):
    if node.nodeType in (node.TEXT_NODE, node.CDATA_SECTION_NODE):
        return ('text', ' '.join(node.data.split()))
    if node.nodeType != node.ELEMENT_NODE:
        return (node.nodeType, node.toxml())
    attrs = []
    for name, value in node.attributes.items():
        if name.startswith('xmlns'):
            continue
        if name in ('src', 'href', 'poster', 'data', 'xlink:href'):
            parts = urlsplit(value)
            if parts.path and not parts.scheme and not parts.netloc:
                value = resource_hash(unquote(parts.path)) + '#' + parts.fragment
        attrs.append((name, value))
    return (node.localName, tuple(sorted(attrs)), tuple(node_key(n, resource_hash) for n in children(node)))


def conflict():
    raise ChapterLockConflict('Source changes conflict with a locally locked chapter; review is required')


def merge_text(base, local, fresh):
    if local == base:
        # A protected source passage can grow, but cannot be removed or rewritten.
        if any(tag not in ('equal', 'insert') for tag, *_ in SequenceMatcher(None, base, fresh, autojunk=False).get_opcodes()):
            conflict()
        return fresh
    boundaries, _ = local_positions(list(base), list(local))
    additions = {}
    for tag, a, b, c, d in SequenceMatcher(None, base, fresh, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        if tag != 'insert' or a not in boundaries:
            conflict()
        additions.setdefault(boundaries[a], []).append(fresh[c:d])
    return ''.join(''.join(additions.get(i, [])) + (local[i] if i < len(local) else '') for i in range(len(local) + 1))


def local_positions(base_keys, local_keys):
    boundaries = {}
    positions = {}
    for tag, a, b, c, d in SequenceMatcher(None, base_keys, local_keys, autojunk=False).get_opcodes():
        boundaries[a] = c
        boundaries[b] = d
        if tag == 'equal' or tag == 'replace' and b - a == d - c:
            for i in range(b - a):
                boundaries[a + i] = c + i
                positions[a + i] = c + i
    return boundaries, positions


def merge_additions(base, local, fresh, base_hash, local_hash, fresh_hash):
    if node_key(base, base_hash) == node_key(fresh, fresh_hash):
        return local.cloneNode(True)
    if base.nodeType in (base.TEXT_NODE, base.CDATA_SECTION_NODE):
        if local.nodeType not in (local.TEXT_NODE, local.CDATA_SECTION_NODE) or fresh.nodeType not in (fresh.TEXT_NODE, fresh.CDATA_SECTION_NODE):
            conflict()
        return local.ownerDocument.createTextNode(merge_text(base.data, local.data, fresh.data))
    if any(n.nodeType != n.ELEMENT_NODE for n in (base, local, fresh)) or base.localName != fresh.localName or base.localName != local.localName:
        conflict()
    # Attribute edits, including a changed source image, are not additive.
    for n, resolver in ((base, base_hash), (fresh, fresh_hash)):
        shell = n.cloneNode(False)
        if n is base:
            base_shell = node_key(shell, resolver)
        elif node_key(shell, resolver) != base_shell:
            conflict()
    old, edited, new = children(base), children(local), children(fresh)
    if max(len(old), len(edited), len(new)) > 10000:
        conflict()
    old_keys = [node_key(n, base_hash) for n in old]
    local_keys = [node_key(n, local_hash) for n in edited]
    new_keys = [node_key(n, fresh_hash) for n in new]
    boundaries, positions = local_positions(old_keys, local_keys)
    additions = {}
    replacements = {}
    for tag, a, b, c, d in SequenceMatcher(None, old_keys, new_keys, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        if tag == 'insert':
            if a not in boundaries:
                conflict()
            additions.setdefault(boundaries[a], []).extend(new[c:d])
        elif tag == 'replace':
            cursor = c
            for old_index in range(a, b):
                if old_index not in positions:
                    conflict()
                index = positions[old_index]
                candidates = []
                for fresh_index in range(cursor, d - (b - old_index - 1)):
                    try:
                        merged = merge_additions(old[old_index], edited[index], new[fresh_index], base_hash, local_hash, fresh_hash)
                    except PolicyError:
                        continue
                    candidates.append((fresh_index, merged))
                if len(candidates) != 1:
                    conflict()
                fresh_index, merged = candidates[0]
                if fresh_index > cursor:
                    if old_index not in boundaries:
                        conflict()
                    additions.setdefault(boundaries[old_index], []).extend(new[cursor:fresh_index])
                replacements[index] = merged
                cursor = fresh_index + 1
            if cursor < d:
                if b not in boundaries:
                    conflict()
                additions.setdefault(boundaries[b], []).extend(new[cursor:d])
        else:
            conflict()
    result = local.cloneNode(False)
    for i in range(len(edited) + 1):
        for n in additions.get(i, []):
            result.appendChild(result.ownerDocument.importNode(n, True))
        if i < len(edited):
            result.appendChild(replacements.get(i, edited[i]).cloneNode(True))
    return result


def baseline_data(archive, chapter_path, data, parse):
    doc = parse(data)
    hashes = {}
    import hashlib
    for n in doc.getElementsByTagName('*'):
        for attr in ('src', 'href', 'poster', 'data', 'xlink:href'):
            value = n.getAttribute(attr)
            parts = urlsplit(value)
            if parts.path and not parts.scheme and not parts.netloc:
                path = posixpath.normpath(posixpath.join(posixpath.dirname(chapter_path), unquote(parts.path)))
                if path in archive.namelist():
                    hashes[path] = hashlib.sha256(archive.read(path)).hexdigest()
    return json.dumps({'version': 1, 'sourcePath': chapter_path, 'html': data.decode('utf-8-sig'), 'resourceHashes': hashes}, ensure_ascii=False).encode()
