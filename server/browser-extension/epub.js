/* exported buildStoryEpub */
async function buildStoryEpub(id) {
  const storage = chrome.storage.local;
  const key = 'story:' + id + ':';
  const info = (await storage.get(key + 'info'))[key + 'info'];
  if (!info || !Number.isInteger(info.count) || info.count < 1) throw new Error('Collect this story first.');
  const chapters = Array.from({ length: info.count }, (_, i) => i + 1);
  const clean = (value) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const xml = (value) => clean(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const metadataText = (value) => '<![CDATA[' + clean(value).replaceAll(']]>', ']]]]><![CDATA[>') + ']]>';
  const title = xml(info.title);
  const canonical = 'https://www.fanfiction.net/s/' + id + '/1/';
  const epub = new zip.ZipWriter(new zip.BlobWriter('application/epub+zip'), { useWebWorkers: false });
  const add = (name, text, options) => epub.add(name, new zip.TextReader(text), options);
  await add('mimetype', 'application/epub+zip', { level: 0, extendedTimestamp: false, dataDescriptor: false });
  await add(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const xhtml = (heading, body) =>
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>' +
    heading +
    '</title></head><body>' +
    body +
    '</body></html>';
  const links = [];
  for (const i of chapters) {
    const chapter = (await storage.get(key + i))[key + i];
    if (!chapter) throw new Error('The saved chapters changed. Collect this story again.');
    const heading = xml(chapter.heading);
    await add('chapter' + i + '.xhtml', xhtml(heading, '<h1>' + heading + '</h1>' + chapter.body));
    links.push('<li><a href="chapter' + i + '.xhtml">' + heading + '</a></li>');
  }
  await add('nav.xhtml', xhtml(title, '<nav epub:type="toc"><h1>' + title + '</h1><ol>' + links.join('') + '</ol></nav>'));
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const items = chapters.map((i) => `<item id="c${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map((i) => `<itemref idref="c${i}"/>`).join('');
  await add(
    'content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${canonical}</dc:identifier><dc:source>${canonical}</dc:source>
    <dc:title>${metadataText(info.title)}</dc:title><dc:creator>${metadataText(info.author)}</dc:creator>
    <dc:language>und</dc:language><meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest><item id="nav" properties="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>${items}</manifest>
  <spine>${spine}</spine>
</package>`,
  );
  const blob = await epub.close();
  if (blob.size > 128 * 1024 * 1024) throw new Error('This EPUB exceeds BookOrbit’s 128 MiB upload limit.');
  return { blob, info };
}
