"""Retain explicitly locked local chapters when refreshing a source EPUB."""
import hashlib
import json
import mimetypes
import os
import posixpath
import re
import tempfile
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile, ZIP_DEFLATED
from xml.parsers import expat

from epub_policy import LIBRARY_EPUB_LIMIT, validate_epub
from publisher_edition import package, parse
from safe_transport import PolicyError
from chapter_lock_merge import BASELINE, ChapterLockConflict, merge_additions, baseline_data

LOCK = 'bookorbit:chapter-lock'
CSS_URL = re.compile(r'url\(\s*([\'"]?)([^)\'"\s]+)\1\s*\)', re.I)


def elements(doc, name):
    return [n for n in doc.getElementsByTagName('*') if n.localName == name]


def chapter_metadata(data):
    """Read strict XML metadata without parsing an unrelated legacy body."""
    # Older downloads used literal hearts such as <3 in titles and their meta
    # values. A digit cannot start an XML element. Escape that literal text
    # without repairing attribute structure or relaxing lock metadata.
    data = re.sub(rb'<(?=[0-9])', b'&lt;', data[:2 * 1024 * 1024])
    parser = expat.ParserCreate(namespace_separator='|')
    metadata = {}
    depth = 0
    head = False

    class HeadComplete(Exception):
        pass

    def reject(*_args):
        raise PolicyError('Unexpected XML declaration')

    def start(name, attributes):
        nonlocal depth, head
        depth += 1
        name = name.rsplit('|', 1)[-1]
        if depth == 2 and name == 'head':
            head = True
        if head and depth == 3 and name == 'meta':
            metadata[attributes.get('name', '')] = attributes.get('content', '')

    def end(name):
        nonlocal depth
        if head and depth == 2 and name.rsplit('|', 1)[-1] == 'head':
            raise HeadComplete()
        depth -= 1

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.StartDoctypeDeclHandler = reject
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    try:
        # Bound header work independently of chapter length. Locked bodies are
        # still parsed in full before any local content is copied or merged.
        parser.Parse(data[:2 * 1024 * 1024], True)
    except HeadComplete:
        return metadata
    raise PolicyError('Chapter header is missing')


def chapters(archive, metadata_only=False):
    opf_path, opf = package(archive)
    items = {n.getAttribute('id'): n for n in elements(opf, 'item')}
    found = {}
    occurrences = defaultdict(int)
    for ref in elements(opf, 'itemref'):
        item = items[ref.getAttribute('idref')]
        if item.getAttribute('media-type') != 'application/xhtml+xml':
            continue
        path = posixpath.normpath(posixpath.join(posixpath.dirname(opf_path), unquote(item.getAttribute('href'))))
        data = archive.read(path)
        # FanFicFare chapters carry their stable source URL in the head.
        if b'chapterurl' not in data:
            continue
        if metadata_only:
            metas = chapter_metadata(data)
        else:
            doc = parse(data)
            metas = {n.getAttribute('name'): n.getAttribute('content') for n in elements(doc, 'meta')}
        url = metas.get('chapterurl')
        if not url or urlsplit(url).scheme not in ('http', 'https'):
            continue
        identity = url.replace('http://', 'https://', 1)
        key = (identity, occurrences[identity])
        occurrences[identity] += 1
        found[key] = (path, data, metas.get(LOCK) == 'true')
    return opf_path, opf, found


def preserve_chapter_locks(previous, output):
    validate_epub(previous, LIBRARY_EPUB_LIMIT)
    validate_epub(output, LIBRARY_EPUB_LIMIT)
    temporary = None
    try:
        with ZipFile(previous) as old, ZipFile(output) as new:
            _, old_opf, saved = chapters(old, metadata_only=True)
            locked = {key: value for key, value in saved.items() if value[2]}
            if not locked:
                return 0
            opf_path, opf, updated = chapters(new)
            if locked.keys() - updated.keys():
                raise ChapterLockConflict('A locally locked chapter is missing from the updated story')
            chapter_paths = {value[0]: updated[key][0] for key, value in saved.items() if key in updated}
            media = {}
            old_opf_path, _ = package(old)
            for item in elements(old_opf, 'item'):
                path = posixpath.normpath(posixpath.join(posixpath.dirname(old_opf_path), unquote(item.getAttribute('href'))))
                media[path] = item.getAttribute('media-type')
            assets = {}
            copied = {}
            replacements = {}
            size = 0

            def resource(path):
                nonlocal size
                if path in copied:
                    return copied[path]
                if path not in old.namelist():
                    raise PolicyError('A locked chapter resource is missing')
                data = old.read(path)
                size += len(data)
                if size > LIBRARY_EPUB_LIMIT:
                    raise PolicyError('Locked chapter resources exceed the EPUB limit')
                extension = posixpath.splitext(path)[1].lower()
                if not re.fullmatch(r'\.[a-z0-9]{1,10}', extension):
                    extension = '.bin'
                digest = hashlib.sha256(path.encode() + b'\0' + data).hexdigest()
                destination = posixpath.join(posixpath.dirname(opf_path), 'bookorbit-preserved', digest + extension)
                copied[path] = destination
                kind = media.get(path) or mimetypes.guess_type(path)[0] or 'application/octet-stream'
                if kind == 'text/css':
                    data = rewrite_css(data.decode('utf-8-sig'), path, destination).encode()
                assets[destination] = (data, kind)
                return destination

            def reference(value, source, destination):
                parts = urlsplit(value)
                if not value or value.startswith('#') or parts.scheme or parts.netloc:
                    return value
                path = posixpath.normpath(posixpath.join(posixpath.dirname(source), unquote(parts.path)))
                if path in chapter_paths:
                    target = chapter_paths[path]
                elif path.endswith(('.html', '.xhtml')):
                    raise PolicyError('A locked chapter links to a missing chapter')
                else:
                    target = resource(path)
                return posixpath.relpath(target, posixpath.dirname(destination) or '.') + ('#' + parts.fragment if parts.fragment else '')

            def rewrite_css(css, source, destination):
                css = CSS_URL.sub(lambda m: 'url("' + reference(m[2], source, destination) + '")', css)
                return re.sub(r'(@import\s+)([\'"])([^\'"]+)\2',
                              lambda m: m[1] + '"' + reference(m[3], source, destination) + '"', css, flags=re.I)

            def rewrite(node, source, destination):
                for child in [node] + list(node.getElementsByTagName('*')):
                    for attr in ('src', 'href', 'poster', 'data', 'xlink:href'):
                        if child.hasAttribute(attr):
                            child.setAttribute(attr, reference(child.getAttribute(attr), source, destination))
                    if child.hasAttribute('srcset'):
                        raise PolicyError('Locked chapter srcset needs explicit resource references')
                    if child.hasAttribute('style'):
                        child.setAttribute('style', rewrite_css(child.getAttribute('style'), source, destination))
                    if child.localName == 'style':
                        text = ''.join(n.data for n in child.childNodes if n.nodeType in (n.TEXT_NODE, n.CDATA_SECTION_NODE))
                        while child.firstChild:
                            child.removeChild(child.firstChild)
                        child.appendChild(child.ownerDocument.createTextNode(rewrite_css(text, source, destination)))

            for key, (source, data, _) in locked.items():
                destination, fresh, _ = updated[key]
                local = parse(data)
                doc = parse(fresh)
                bodies = elements(local, 'body')
                targets = elements(doc, 'body')
                if len(bodies) != 1 or len(targets) != 1:
                    raise PolicyError('Locked chapter body is invalid')
                body = doc.importNode(bodies[0], True)
                rewrite(body, source, destination)
                baseline_meta = next((n for n in elements(local, 'meta') if n.getAttribute('name') == BASELINE), None)
                if baseline_meta is not None:
                    baseline_path = posixpath.normpath(posixpath.join(posixpath.dirname(source), unquote(baseline_meta.getAttribute('content'))))
                    baseline = json.loads(old.read(baseline_path))
                    if baseline.get('version') != 1 or not isinstance(baseline.get('resourceHashes'), dict):
                        raise PolicyError('Locked chapter baseline is invalid')
                    base = parse(baseline['html'].encode())
                    def base_hash(path):
                        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(baseline['sourcePath']), path))
                        return baseline['resourceHashes'].get(resolved, path)
                    def fresh_hash(path):
                        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(destination), path))
                        if resolved in new.namelist():
                            return hashlib.sha256(new.read(resolved)).hexdigest()
                        return path
                    def local_hash(path):
                        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(destination), path))
                        if resolved in assets:
                            return hashlib.sha256(assets[resolved][0]).hexdigest()
                        return fresh_hash(path)
                    body = merge_additions(elements(base, 'body')[0], body, targets[0], base_hash, local_hash, fresh_hash)
                targets[0].parentNode.replaceChild(body, targets[0])
                head = elements(doc, 'head')[0]
                for n in list(head.childNodes):
                    if n.nodeType == n.ELEMENT_NODE and (n.localName == 'style' or
                            n.localName == 'link' and n.getAttribute('rel') == 'stylesheet' or
                            n.localName == 'meta' and n.getAttribute('name') in (LOCK, BASELINE)):
                        head.removeChild(n)
                for n in elements(local, 'head')[0].childNodes:
                    if n.nodeType == n.ELEMENT_NODE and (n.localName == 'style' or
                            n.localName == 'link' and n.getAttribute('rel') == 'stylesheet'):
                        clone = doc.importNode(n, True)
                        rewrite(clone, source, destination)
                        head.appendChild(clone)
                marker = doc.createElement('meta')
                marker.setAttribute('name', LOCK)
                marker.setAttribute('content', 'true')
                head.appendChild(marker)
                if baseline_meta is not None:
                    baseline_bytes = baseline_data(new, destination, fresh, parse)
                    baseline_name = posixpath.join(posixpath.dirname(opf_path), 'bookorbit-preserved', hashlib.sha256(baseline_bytes).hexdigest() + '.json')
                    assets[baseline_name] = (baseline_bytes, 'application/json')
                    marker = doc.createElement('meta')
                    marker.setAttribute('name', BASELINE)
                    marker.setAttribute('content', posixpath.relpath(baseline_name, posixpath.dirname(destination) or '.'))
                    head.appendChild(marker)
                replacements[destination] = doc.toxml(encoding='utf-8')
            manifest = elements(opf, 'manifest')[0]
            identifiers = {n.getAttribute('id') for n in elements(opf, 'item')}
            existing = {posixpath.normpath(posixpath.join(posixpath.dirname(opf_path), unquote(n.getAttribute('href')))) for n in elements(opf, 'item')}
            for path, (_, kind) in assets.items():
                if path in existing:
                    continue
                identifier = 'bookorbit-preserved-' + hashlib.sha256(path.encode()).hexdigest()
                if identifier in identifiers:
                    raise PolicyError('Locked chapter resource identity conflicts with the updated book')
                item = opf.createElementNS(manifest.namespaceURI, 'item')
                item.setAttribute('id', identifier)
                item.setAttribute('href', posixpath.relpath(path, posixpath.dirname(opf_path) or '.'))
                item.setAttribute('media-type', kind)
                manifest.appendChild(item)
            replacements[opf_path] = opf.toxml(encoding='utf-8')
            with tempfile.NamedTemporaryFile(dir=Path(output).parent, suffix='.epub', delete=False) as file:
                temporary = file.name
            with ZipFile(temporary, 'w') as archive:
                for entry in new.infolist():
                    if entry.filename in assets:
                        continue
                    archive.writestr(entry, replacements.get(entry.filename, new.read(entry.filename)))
                for name, (data, _) in assets.items():
                    archive.writestr(name, data, compress_type=ZIP_DEFLATED)
            validate_epub(temporary, LIBRARY_EPUB_LIMIT)
            with open(temporary, 'rb') as file:
                os.fsync(file.fileno())
            os.replace(temporary, output)
            return len(locked)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
