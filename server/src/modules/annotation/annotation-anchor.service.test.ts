import { Test } from '@nestjs/testing';
import type { ReadingAnchor } from '@bookorbit/types';
import { AnnotationAnchorService } from './annotation-anchor.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';

describe('annotation source identity', () => {
  const anchor: ReadingAnchor = {
    schemaVersion: 1,
    bookId: 5,
    bookFileId: 9,
    revision: 'ed982f67-8c1c-49bc-ae25-a1d9781f7ea0',
    nativeLocator: { kind: 'xpointer', value: '/original' },
    chapterIndex: 0,
    chapterFraction: 0,
    bookFraction: 0,
    quote: 'Original selected passage',
  };
  async function setup() {
    const revisions = { requireRevisions: vi.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      providers: [AnnotationAnchorService, { provide: RevisionCatalogService, useValue: revisions }],
    }).compile();
    return { service: module.get(AnnotationAnchorService), revisions };
  }
  it('checks distinct revision identities in one scoped batch', async () => {
    const { service, revisions } = await setup();
    await service.validate(5, 9, [anchor, anchor]);
    expect(revisions.requireRevisions).toHaveBeenCalledExactlyOnceWith(9, [anchor.revision]);
  });
  it('accepts an offline provisional identity without inventing a server revision', async () => {
    const { service, revisions } = await setup();
    const sha = 'a'.repeat(64);
    await service.validate(5, 9, [{ ...anchor, revision: `sha256:${sha}`, provisionalSha256: sha }]);
    expect(revisions.requireRevisions).toHaveBeenCalledWith(9, []);
  });
  it.each([{ bookId: 6 }, { bookFileId: 10 }, { schemaVersion: undefined }, { nativeLocator: undefined }, { revision: 'sha256:invalid' }])(
    'rejects incomplete or unrelated identity %j',
    async (change) => {
      const { service, revisions } = await setup();
      await expect(service.validate(5, 9, [{ ...anchor, ...change }])).rejects.toThrow();
      expect(revisions.requireRevisions).not.toHaveBeenCalled();
    },
  );
});
