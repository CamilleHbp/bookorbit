"""Complete editions published by Michael J. Cropo on his own website."""
import hashlib
from pathlib import Path
from zipfile import ZipFile

from xml.dom import minidom
from epub_policy import validate_epub, LIBRARY_EPUB_LIMIT
from safe_transport import PolicyError

SITE = 'aspartanswarchronicles.com'
ROOT = 'https://' + SITE + '/files/books/'
EDITIONS = {
    ROOT + '1/1-Time_of_Eden_and_Elves_Michael_J_Cropo.epub': 'Time of Eden and Elves',
    ROOT + '3/3-Discovery_Michael_J_Cropo.epub': 'Discovery',
    ROOT + '5/5-Wolves_and_Dragons_of_the_Blood_Revelations_Michael_J_Cropo.epub': 'Wolves and Dragons of the Blood: Revelations',
}
DC = 'http://purl.org/dc/elements/1.1/'
OPF = 'http://www.idpf.org/2007/opf'
STAMP = 'bookorbit:publisher-sha256'


def parse(data):
    if len(data) > 2 * 1024 * 1024:
        raise PolicyError('Publisher metadata exceeds its size limit')
    text = data.decode('utf-8-sig')
    if '<!DOCTYPE' in text or '<!ENTITY' in text or '\0' in text:
        raise PolicyError('Unexpected XML declaration')
    return minidom.parseString(text)


def package(archive):
    container = parse(archive.read('META-INF/container.xml'))
    path = container.getElementsByTagNameNS('*', 'rootfile')[0].getAttribute('full-path')
    return path, parse(archive.read(path))


def value(node):
    return ''.join(c.data for c in node.childNodes if c.nodeType in (c.TEXT_NODE, c.CDATA_SECTION_NODE)).strip()


def edition(request, transport):
    url = request['url']
    operation = request['operation']
    if operation not in ('preview', 'download', 'update', 'refresh'):
        raise PolicyError('Unsupported publisher operation')
    status, data, final = transport.request('GET', url)
    if status != 200 or final != url:
        raise PolicyError('Publisher did not return the requested edition')
    digest = hashlib.sha256(data).hexdigest()
    path = Path('publisher.epub')
    path.write_bytes(data)
    validate_epub(path)
    with ZipFile(path) as archive:
        name, doc = package(archive)
        title = value(doc.getElementsByTagNameNS(DC, 'title')[0])
        authors = [value(n) for n in doc.getElementsByTagNameNS(DC, 'creator')]
        if title.casefold() != EDITIONS[url].casefold() or 'Michael J. Cropo' not in authors:
            raise PolicyError('The publisher returned a different book')
        count = len([n for n in doc.getElementsByTagNameNS(OPF, 'itemref') if n.getAttribute('linear') != 'no'])
        preview = dict(canonicalUrl=url, site=SITE, title=title, authors=authors, description='', chapterCount=count,
                       wordCount=None, status='', tags=[], rawLabels=[])
        version = (request.get('tagMatching') or {}).get('version')
        if version:
            preview['labelMappingVersion'] = version
        if operation == 'preview':
            return preview
        if operation in ('update', 'refresh'):
            validate_epub('input.epub', LIBRARY_EPUB_LIMIT)
            with ZipFile('input.epub') as saved:
                _, previous = package(saved)
                if url not in [value(n) for n in previous.getElementsByTagNameNS(DC, 'source')]:
                    return {'reviewRequired': 'identity_mismatch', 'preview': preview}
                if any(n.getAttribute('name') == STAMP and n.getAttribute('content') == digest
                       for n in previous.getElementsByTagNameNS(OPF, 'meta')):
                    return {'preview': preview, 'output': 'input.epub', 'unchangedEdition': True}
        metadata = doc.getElementsByTagNameNS(OPF, 'metadata')[0]
        source = doc.createElementNS(DC, 'dc:source')
        source.setAttribute('xmlns:dc', DC)
        source.appendChild(doc.createTextNode(url))
        metadata.appendChild(source)
        stamp = doc.createElementNS(OPF, 'meta')
        stamp.setAttribute('xmlns', OPF)
        stamp.setAttribute('name', STAMP)
        stamp.setAttribute('content', digest)
        metadata.appendChild(stamp)
        with ZipFile('output.epub', 'w') as out:
            for item in archive.infolist():
                out.writestr(item, doc.toxml(encoding='utf-8') if item.filename == name else archive.read(item))
    return {'preview': preview, 'output': 'output.epub'}
