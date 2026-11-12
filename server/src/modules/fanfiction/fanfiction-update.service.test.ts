import { FanfictionReviewService } from './fanfiction-review.service';
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type * as schema from '../../db/schema';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { EpubManifestService } from '../book-revision/epub-manifest.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { RevisionDownloadService } from '../book-revision/revision-download.service';
import { RevisionPublicationService } from '../book-revision/revision-publication.service';
import { MetadataService } from '../metadata/metadata.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionUpdateService } from './fanfiction-update.service';

describe('fanfiction update covers', () => {
  it('downloads again with the website connection when an approved publication is missing', async () => {
    const runtime = { update: vi.fn().mockResolvedValue({ noChange: true }) };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionUpdateService,
        { provide: FanficfareRuntimeService, useValue: runtime },
        {
          provide: FanfictionSourceService,
          useValue: {
            updateContext: vi.fn().mockResolvedValue({ bookFileId: 3, libraryId: 1, canonicalUrl: 'https://example.org/story' }),
            expectRevision: vi.fn().mockResolvedValue('revision'),
          },
        },
        { provide: RevisionPublicationService, useValue: { ownedPublication: vi.fn().mockResolvedValue(null) } },
        { provide: RevisionCatalogService, useValue: { requireFile: vi.fn(), current: vi.fn().mockResolvedValue({ id: 'revision' }) } },
        { provide: BookRevisionService, useValue: { observeFile: vi.fn() } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    try {
      const website = { document: { configuration: 'saved connection', cookies: [] }, saveCookies: vi.fn() };
      await module.get(FanfictionUpdateService).run(
        {
          id: 'job',
          kind: 'update',
          result: { preparedUpdate: { approved: true, noChange: false }, preview: {} },
        } as typeof schema.fanfictionJobs.$inferSelect,
        website.document,
        vi.fn(),
        new AbortController().signal,
        website.saveCookies,
      );
      expect(runtime.update.mock.calls[0][2]).toBe(website.document);
      expect(runtime.update.mock.calls[0]).toContain(website.saveCookies);
    } finally {
      await module.close();
    }
  });

  it.each([false, true])('refreshes a resumed publication cover only while book ownership matches: changed=%s', async (changed) => {
    const metadata = { refreshCoverForBook: vi.fn().mockResolvedValue(true) };
    const sources = {
      updateContext: vi.fn().mockResolvedValue({ id: 'source', libraryId: 1, bookId: 2, bookFileId: 3 }),
      completeUpdate: vi.fn().mockImplementation((_job, result) => result),
    };
    const module = await Test.createTestingModule({
      providers: [
        { provide: FanfictionReviewService, useValue: { decide: vi.fn(), importDecision: vi.fn() } },
        FanfictionUpdateService,
        { provide: MetadataService, useValue: metadata },
        { provide: FanfictionSourceService, useValue: sources },
        {
          provide: RevisionCatalogService,
          useValue: { fileLocation: vi.fn().mockResolvedValue({ bookId: changed ? 4 : 2, absolutePath: '/books/story.epub' }) },
        },
        {
          provide: RevisionPublicationService,
          useValue: {
            ownedPublication: vi.fn().mockResolvedValue({ id: 'publication' }),
            resume: vi.fn().mockResolvedValue({ revisionId: 'revision' }),
          },
        },
        ...[FanficfareRuntimeService, BookRevisionService, RevisionDownloadService, EpubManifestService].map((provide) => ({
          provide,
          useValue: {},
        })),
      ],
    }).compile();
    try {
      const authorize = vi.fn().mockResolvedValue(undefined);
      const result = module
        .get(FanfictionUpdateService)
        .run(
          { id: 'job', libraryId: 1, kind: 'update' } as typeof schema.fanfictionJobs.$inferSelect,
          { configuration: '', cookies: [] },
          authorize,
          new AbortController().signal,
        );
      if (changed) {
        await expect(result).rejects.toBeInstanceOf(ConflictException);
        expect(metadata.refreshCoverForBook).not.toHaveBeenCalled();
        expect(sources.completeUpdate).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toMatchObject({ revisionId: 'revision' });
        expect(metadata.refreshCoverForBook).toHaveBeenCalledWith(2, '/books/story.epub', 'epub');
        expect(authorize).toHaveBeenCalledTimes(2);
        expect(metadata.refreshCoverForBook.mock.invocationCallOrder[0]).toBeLessThan(sources.completeUpdate.mock.invocationCallOrder[0]);
      }
    } finally {
      await module.close();
    }
  });
});
