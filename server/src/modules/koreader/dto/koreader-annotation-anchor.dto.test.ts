import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { AnnotationExchangeDto } from './koreader-exchange.dto';
import { readFile } from 'node:fs/promises';

describe('KOReader annotation anchor request contract', () => {
  it.skipIf(!process.env.KOREADER_ANNOTATION_PAYLOAD)('accepts the actual KOReader offline-restoration upload', async () => {
    const payload = JSON.parse(await readFile(process.env.KOREADER_ANNOTATION_PAYLOAD!, 'utf8'));
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const validated = await pipe.transform(payload, { type: 'body', metatype: AnnotationExchangeDto });
    expect(validated.books[0].changes[0].sourceAnchor).toMatchObject({ schemaVersion: 1, bookId: 2, bookFileId: 9 });
    expect(validated.books[0].changes[0].sourceAnchor.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('accepts original anchors alongside installed native positions and rejects extra nested fields', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const sha = 'a'.repeat(64);
    const sourceAnchor = {
      schemaVersion: 1,
      bookId: 2,
      bookFileId: 9,
      revision: `sha256:${sha}`,
      provisionalSha256: sha,
      nativeLocator: { kind: 'xpointer', value: '/original' },
      chapterIndex: 0,
      chapterFraction: 0.1,
      bookFraction: 0.2,
      quote: 'Original passage',
    };
    const change = {
      datetime: '2026-09-05 12:00:00',
      drawer: 'lighten',
      text: 'Original passage',
      posFormat: 'xpointer',
      pos0: '/installed',
      sourceAnchor,
    };
    const payload = {
      deviceId: 'offline-runtime-device',
      deviceModel: 'Emulator',
      pluginVersion: '1.5.2',
      books: [{ hash: 'a'.repeat(32), keys: [], keysComplete: false, changes: [change] }],
    };
    const metadata = { type: 'body' as const, metatype: AnnotationExchangeDto };
    expect(await pipe.transform(payload, metadata)).toMatchObject(payload);
    change.sourceAnchor = { ...sourceAnchor, unexpected: true } as typeof sourceAnchor;
    await expect(pipe.transform(payload, metadata)).rejects.toThrow();
  });
});
