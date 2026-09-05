import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { RevisionApiService } from './revision-api.service';
import { RevisionCatalogService } from './revision-catalog.service';
import { ListRevisionsDto } from './dto/reading-anchor.dto';

const user = { id: 1, isSuperuser: false } as RequestUser;
const libraries = { verifyUserAccess: vi.fn() };
const revisions = { list: vi.fn(), manifest: vi.fn(), resolve: vi.fn() };
let service: RevisionApiService;
beforeEach(async () => {
  vi.resetAllMocks();
  const module = await Test.createTestingModule({
    providers: [RevisionApiService, { provide: LibraryService, useValue: libraries }, { provide: RevisionCatalogService, useValue: revisions }],
  }).compile();
  service = module.get(RevisionApiService);
});

describe('revision access', () => {
  it('rechecks library access before reading history, manifests, or resolving anchors', async () => {
    libraries.verifyUserAccess.mockRejectedValue(new ForbiddenException());
    await expect(service.list(7, 9, new ListRevisionsDto(), user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.manifest(7, 9, 'revision', user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.resolve(
        7,
        9,
        { targetRevisionId: 'revision', anchor: { revision: 'old', chapterIndex: 0, chapterFraction: 0, bookFraction: 0 } },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    for (const method of Object.values(revisions)) expect(method).not.toHaveBeenCalled();
    expect(libraries.verifyUserAccess).toHaveBeenCalledWith(1, 7, false);
  });

  it('passes a scoped bounded request and preserves the response contract', async () => {
    const page = { items: [], nextCursor: null };
    revisions.list.mockResolvedValue(page);
    await expect(service.list(7, 9, new ListRevisionsDto(), user)).resolves.toEqual(page);
    expect(revisions.list).toHaveBeenCalledWith(9, 7, 50, undefined);
  });
});
