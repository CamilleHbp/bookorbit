import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookService } from '../../book/book.service';
import { BookRevisionService } from '../../book-revision/book-revision.service';
import { RevisionDownloadService } from '../../book-revision/revision-download.service';
import { UserService } from '../../user/user.service';
import type { RequestUser } from '../../../common/types/request-user';
import { EpubRevisionService } from './epub-revision.service';

describe('EPUB reading revision boundary', () => {
  const books = { verifyFileAccess: vi.fn() };
  const revisions = { observeFile: vi.fn() };
  const downloads = { download: vi.fn() };
  const users = { findByIdWithPermissions: vi.fn() };
  const user = { id: 7, active: true, tokenVersion: 3 } as RequestUser;
  let service: EpubRevisionService;
  beforeEach(async () => {
    vi.resetAllMocks();
    books.verifyFileAccess.mockResolvedValue({ bookId: 2, libraryId: 5, format: 'epub' });
    revisions.observeFile.mockResolvedValue({ currentRevisionId: 'revision', sha256: 'sha256', sizeBytes: 45 });
    users.findByIdWithPermissions.mockResolvedValue(user);
    downloads.download.mockImplementation(async (_file, _library, _revision, check) => {
      await check();
      return { stream: 'snapshot' };
    });
    const module = await Test.createTestingModule({
      providers: [
        EpubRevisionService,
        { provide: BookService, useValue: books },
        { provide: BookRevisionService, useValue: revisions },
        { provide: RevisionDownloadService, useValue: downloads },
        { provide: UserService, useValue: users },
      ],
    }).compile();
    service = module.get(EpubRevisionService);
  });
  it('lazily inspects the initial revision after checking file access', async () => {
    expect(await service.current(2, 9, user)).toEqual({
      bookId: 2,
      bookFileId: 9,
      libraryId: 5,
      revision: 'revision',
      sha256: 'sha256',
      sizeBytes: 45,
    });
    expect(revisions.observeFile).toHaveBeenCalledWith(9, {});
    expect(books.verifyFileAccess).toHaveBeenCalledTimes(2);
  });
  it('rejects denied access and book/file mismatches before inspecting bytes', async () => {
    books.verifyFileAccess.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.current(2, 9, user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.current(3, 9, user)).rejects.toThrow('EPUB file not found');
    expect(revisions.observeFile).not.toHaveBeenCalled();
  });
  it('rechecks account and file access while streaming the verified revision', async () => {
    await expect(service.snapshot(2, 9, 'revision', user, () => false)).resolves.toEqual({ stream: 'snapshot' });
    const check = downloads.download.mock.calls[0]![3] as () => Promise<void>;
    users.findByIdWithPermissions.mockResolvedValueOnce({ ...user, tokenVersion: 4 });
    await expect(check()).rejects.toThrow('Reader access');
    books.verifyFileAccess.mockRejectedValueOnce(new ForbiddenException());
    await expect(check()).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('rejects cancellation and cross-library moves', async () => {
    await expect(service.snapshot(2, 9, 'revision', user, () => true)).rejects.toThrow('cancelled');
    books.verifyFileAccess.mockResolvedValueOnce({ bookId: 2, libraryId: 5, format: 'epub' });
    books.verifyFileAccess.mockResolvedValueOnce({ bookId: 2, libraryId: 6, format: 'epub' });
    await expect(service.current(2, 9, user)).rejects.toThrow('different library');
  });
});
