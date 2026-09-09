import argparse
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from html import escape


def create(path, order, renamed=False, edited=False, empty=False):
    names = {chapter: f'{"renamed" if renamed else "chapter"}-{chapter}.xhtml' for chapter in order}
    manifest = ''.join(f'<item id="c{chapter}" href="{names[chapter]}" media-type="application/xhtml+xml"/>' for chapter in order)
    spine = ''.join(f'<itemref idref="c{chapter}"/>' for chapter in order)
    nav = ''.join(f'<li><a href="{names[chapter]}">Chapter {chapter}</a></li>' for chapter in order)
    with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('mimetype', 'application/epub+zip', compress_type=0)
        archive.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        archive.writestr('book.opf', f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">revision-acceptance-story</dc:identifier><dc:title>Revision acceptance story</dc:title><dc:language>en</dc:language></metadata><manifest>{manifest}<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine>{spine}</spine></package>')
        archive.writestr('nav.xhtml', f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>{nav}</ol></nav></body></html>')
        for chapter in order:
            paragraphs = []
            for number in range(1, 41):
                if edited and chapter == 9 and 15 <= number <= 25:
                    continue
                text = f'Chapter {chapter}, passage {number}. Camille saw the distant lighthouse through the mist. '
                text += f'The {chapter * 101 + number}th lantern carried its own story. Café, café, 中文 and 😀 remained legible. '
                text += 'She followed the narrow stone path beside the water, listening to the waves and remembering the promise she had made. ' * 3
                paragraphs.append(f'<p id="{"new" if renamed else "p"}{number}">{escape(text)}</p>')
            body = '' if empty and chapter == 9 else ''.join(paragraphs)
            archive.writestr(names[chapter], f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {chapter}</title></head><body><h1>Chapter {chapter}</h1>{body}</body></html>')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    destination = parser.parse_args().directory
    destination.mkdir(parents=True, exist_ok=True)
    create(destination / 'original.epub', list(range(1, 11)))
    create(destination / 'appended.epub', list(range(1, 16)))
    create(destination / 'regenerated.epub', list(reversed(range(1, 16))), renamed=True)
    create(destination / 'edited.epub', list(range(1, 16)), renamed=True, edited=True)
    create(destination / 'empty-chapter.epub', list(range(1, 16)), empty=True)
