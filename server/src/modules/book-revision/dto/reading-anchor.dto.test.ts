import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ListRevisionsDto, ResolveReadingAnchorDto } from './reading-anchor.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const revision = '95f66679-bff3-4f7e-a8c6-1d4cf246700a';
const request = {
  targetRevisionId: revision,
  anchor: {
    schemaVersion: 1,
    revision,
    chapterIndex: 0,
    chapterFraction: 0.2,
    bookFraction: 0.1,
    nativeLocator: { kind: 'cfi', value: 'epubcfi(/6/2)' },
    quote: '😀'.repeat(256),
  },
};

function validate(value: unknown) {
  return pipe.transform(value, { type: 'body', metatype: ResolveReadingAnchorDto });
}

describe('revision request contracts', () => {
  it('accepts bounded Unicode anchors and original reading-event identities', async () => {
    const value = {
      ...request,
      anchor: {
        ...request.anchor,
        event: { id: revision, deviceId: 'reader', deviceSequence: 4, occurredAt: '2026-09-05T13:00:00.000Z', resetGeneration: 2 },
      },
    };
    await expect(validate(value)).resolves.toEqual(value);
  });

  it.each([
    { ...request, anchor: undefined },
    { ...request, userId: 4 },
    { ...request, anchor: { ...request.anchor, bookFraction: Infinity } },
    { ...request, anchor: { ...request.anchor, chapterIndex: -1 } },
    { ...request, anchor: { ...request.anchor, quote: '😀'.repeat(257) } },
    { ...request, anchor: { ...request.anchor, nativeLocator: { kind: 'path', value: '/tmp/book' } } },
    { ...request, anchor: { ...request.anchor, event: { deviceSequence: 1 } } },
    { ...request, anchor: { ...request.anchor, extra: true } },
  ])('rejects malformed, oversized, or unrecognized fields', async (value) => {
    await expect(validate(value)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('coerces bounded page sizes and rejects unbounded pagination', async () => {
    await expect(pipe.transform({ limit: '25' }, { type: 'query', metatype: ListRevisionsDto })).resolves.toMatchObject({ limit: 25 });
    await expect(pipe.transform({ limit: '101' }, { type: 'query', metatype: ListRevisionsDto })).rejects.toBeInstanceOf(BadRequestException);
  });
});
