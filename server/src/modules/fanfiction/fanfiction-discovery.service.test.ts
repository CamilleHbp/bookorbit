import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import { EpubManifestService } from '../book-revision/epub-manifest.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { RevisionFileService } from '../book-revision/revision-file.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionConnectionService } from './fanfiction-connection.service';
import { FanfictionDiscoveryService } from './fanfiction-discovery.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { recordedStories } from './fanfiction-story-identity';

const chapter = 'https://archiveofourown.org/chapters/45678';
const work = 'https://archiveofourown.org/works/12345';
const recognized = (url: string, site = 'archiveofourown.org') => ({ recognized: true as const, url, canonicalUrl: url, site });

describe('FanfictionDiscoveryService.previewBook', () => {
  let service: FanfictionDiscoveryService;
  let runtimeService: FanficfareRuntimeService;
  const recognize = vi.fn();
  const preview = vi.fn();
  const sourceEvidence = vi.fn();
  const values = vi.fn();
  const input = { bookId: 1, bookFileId: 2, url: chapter };
  const user = { id: 3 } as RequestUser;

  beforeEach(async () => {
    vi.resetAllMocks();
    values.mockReturnValue({
      onConflictDoNothing: () => ({ returning: () => [{ id: 'candidate', title: 'Story', authors: ['Writer'], chapterCount: 1 }] }),
    });
    const db = {
      insert: () => ({ values }),
      transaction: (callback: (tx: unknown) => unknown) => callback(db),
    };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionDiscoveryService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: { administer: vi.fn() } },
        { provide: FanfictionJobService, useValue: {} },
        {
          provide: RevisionCatalogService,
          useValue: { fileLocation: () => ({ bookId: 1, absolutePath: '/books/story.epub' }), lockFileLocation: vi.fn() },
        },
        { provide: RevisionFileService, useValue: { require: () => ({ sha256: 'hash' }), verifyUnchanged: vi.fn() } },
        { provide: EpubManifestService, useValue: { sourceEvidence } },
        { provide: FanficfareRuntimeService, useValue: { recognize, preview } },
        { provide: FanfictionConnectionService, useValue: { session: () => ({ document: {} }) } },
      ],
    }).compile();
    service = module.get(FanfictionDiscoveryService);
    runtimeService = module.get(FanficfareRuntimeService);
  });

  it('saves the verified work URL after resolving a bare AO3 chapter', async () => {
    sourceEvidence.mockResolvedValue({ title: 'Story', authors: ['Writer'], chapterCount: 1, sourceUrls: [work] });
    recognize.mockResolvedValueOnce([recognized(chapter)]).mockResolvedValue([recognized(work)]);
    preview.mockResolvedValue({ canonicalUrl: work });

    await expect(service.previewBook(1, input, user)).resolves.toMatchObject({ canonicalUrl: work });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ urls: [{ ...recognized(work), url: chapter }] }));
  });

  it('rejects a chapter if its work differs from the EPUB source', async () => {
    const otherWork = 'https://archiveofourown.org/works/54321';
    sourceEvidence.mockResolvedValue({ sourceUrls: [otherWork] });
    recognize
      .mockResolvedValueOnce([recognized(chapter)])
      .mockResolvedValueOnce([recognized(otherWork)])
      .mockResolvedValue([recognized(work)]);
    preview.mockResolvedValue({ canonicalUrl: work });

    await expect(service.previewBook(1, input, user)).rejects.toThrow(ConflictException);
    expect(values).not.toHaveBeenCalled();
  });

  it('does not offer an unresolved chapter as an offline adoption choice', async () => {
    await expect(recordedStories(runtimeService, [recognized(chapter)])).resolves.toEqual([]);
    expect(recognize).not.toHaveBeenCalled();
  });
});
