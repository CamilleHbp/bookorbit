import { CollectionService } from '../collection/collection.service';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { FanfictionPreview } from '@bookorbit/types';
import type * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionImportService } from './fanfiction-import.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { BookDockManagedService } from '../book-dock/book-dock-managed.service';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';

describe('review before importing a story', () => {
  it.each([false, true])('requires approval before downloading or ingesting and uses approved edits: approved=%s', async (approved) => {
    const preview: FanfictionPreview = {
      canonicalUrl: 'https://example.org/story',
      site: 'example.org',
      title: 'Source title',
      authors: ['Author'],
      description: '',
      tags: ['Source tag'],
      chapterCount: 2,
      status: 'In-Progress',
    };
    const values = { title: 'My title', authors: ['Author'], description: 'My description', tags: ['My tag'] };
    const source = { id: 'source', libraryId: 1, folderId: 2, createdBy: 3, canonicalUrl: preview.canonicalUrl, chapterCount: 2, profileId: null };
    const sources = {
      resume: vi.fn().mockResolvedValue({ source, owned: true }),
      assertImportable: vi.fn(),
      recordImportMetadata: vi.fn(),
      completeImport: vi.fn(),
    };
    const dock = { ingest: vi.fn().mockResolvedValue({ bookId: 4, bookFileId: 5 }), isPrepared: vi.fn().mockResolvedValue(false) };
    const runtime = {
      preview: vi.fn().mockResolvedValue(preview),
      download: vi.fn().mockImplementation((_url, _document, consume) => consume('/staged/story.epub', preview)),
    };
    const collections = { verifyWriteAccess: vi.fn(), addBooks: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionImportService,
        { provide: CollectionService, useValue: collections },
        { provide: FanfictionSourceService, useValue: sources },
        { provide: FanficfareRuntimeService, useValue: runtime },
        { provide: BookDockManagedService, useValue: dock },
        { provide: BookRevisionService, useValue: { observeFile: vi.fn() } },
        { provide: RevisionCatalogService, useValue: { requireFile: vi.fn() } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    try {
      const job = {
        profileId: null,
        input: { collectionId: 8 },
        result: approved ? { importReview: { preview, values, approved } } : null,
      } as typeof schema.fanfictionJobs.$inferSelect;
      const result = await module
        .get(FanfictionImportService)
        .run(job, {} as RequestUser, { configuration: '', cookies: [] }, async () => {}, new AbortController().signal);
      expect(collections.verifyWriteAccess).toHaveBeenCalledWith(8, {});
      if (!approved) {
        expect(collections.addBooks).not.toHaveBeenCalled();
        expect(result?.importReview?.approved).toBe(false);
        expect(runtime.download).not.toHaveBeenCalled();
        expect(dock.ingest).not.toHaveBeenCalled();
        expect(sources.completeImport).not.toHaveBeenCalled();
      } else {
        expect(dock.ingest).toHaveBeenCalledWith(expect.objectContaining({ finalMetadata: values }), expect.any(Function));
        expect(result?.bookId).toBe(4);
        expect(collections.addBooks).toHaveBeenCalledWith(8, { bookIds: [4] }, {});
        expect(dock.ingest).toHaveBeenCalledWith(expect.objectContaining({ personalTags: ['My tag'] }), expect.any(Function));
        expect(result?.importReview).toBeUndefined();
      }
    } finally {
      await module.close();
    }
  });
});
