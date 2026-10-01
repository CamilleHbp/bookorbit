import { Test } from '@nestjs/testing';
import { storageConfig } from '../../../config/config';
import { ZipArchive } from 'archiver';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as unzipper from 'unzipper';
import { describe, expect, it } from 'vitest';
import { RevisionFileModule } from '../../book-revision/revision-file.module';
import { KepubConversionService } from './kepub-conversion.service';
import { KepubifyBinaryService } from './kepubify-binary.service';

describe('bundled kepubify publication', () => {
  it('publishes and reuses a structurally valid EPUB from the actual bundled converter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bookorbit-kepub-runtime-'));
    const module = await Test.createTestingModule({
      imports: [RevisionFileModule],
      providers: [KepubConversionService, KepubifyBinaryService, { provide: storageConfig.KEY, useValue: { appDataPath: directory } }],
    }).compile();
    try {
      const source = join(directory, 'source.epub');
      const archive = new ZipArchive({ store: true });
      const chunks: Buffer[] = [];
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<void>((resolve, reject) => {
        archive.on('end', resolve);
        archive.on('error', reject);
      });
      for (const [name, content] of Object.entries({
        mimetype: 'application/epub+zip',
        'META-INF/container.xml':
          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'content.opf':
          '<package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Revision fixture</dc:title><dc:identifier id="id">fixture</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        'chapter.xhtml':
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>The original passage must survive conversion.</p></body></html>',
      }))
        archive.append(content, { name });
      await archive.finalize();
      await done;
      await writeFile(source, Buffer.concat(chunks));
      const service = module.get(KepubConversionService);
      const input = { sourcePath: source, bookId: 1, hyphenate: true };
      const output = await service.getKepubPath(input);
      expect(await readFile(output)).not.toEqual(await readFile(source));
      const converted = await unzipper.Open.file(output);
      const chapter = converted.files.find((entry) => entry.path === 'chapter.xhtml');
      expect(chapter).toBeDefined();
      const content = (await chapter!.buffer()).toString('utf8');
      expect(content).toContain('koboSpan');
      expect(content).toContain('The original passage must survive conversion.');
      expect(await service.getKepubPath(input)).toBe(output);
    } finally {
      await module.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
