import { Test } from '@nestjs/testing';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { BookService } from '../book/book.service';
import { UserService } from '../user/user.service';
import { RevisionDownloadApiService } from './revision-download-api.service';
import { RevisionDownloadService } from './revision-download.service';
import { beforeEach, expect, it, vi } from 'vitest';

const user = { id: 1, active: true, tokenVersion: 2, isSuperuser: false, permissions: [Permission.LibraryDownload] } as RequestUser;
const users = { findByIdWithPermissions: vi.fn() };
const books = { verifyFileAccess: vi.fn() };
const downloads = { download: vi.fn() };
let service: RevisionDownloadApiService;
let check: () => Promise<void>;
beforeEach(async () => {
  vi.resetAllMocks();
  users.findByIdWithPermissions.mockResolvedValue(user);
  books.verifyFileAccess.mockResolvedValue({ libraryId: 3 });
  downloads.download.mockImplementation(async (_file, _library, _revision, callback) => {
    check = callback;
    await check();
    return { revisionId: 'revision' };
  });
  const module = await Test.createTestingModule({
    providers: [
      RevisionDownloadApiService,
      { provide: UserService, useValue: users },
      { provide: BookService, useValue: books },
      { provide: RevisionDownloadService, useValue: downloads },
    ],
  }).compile();
  service = module.get(RevisionDownloadApiService);
});

it('rechecks current account permissions, token version and file access during streaming', async () => {
  await expect(service.download(3, 5, 'revision', user, () => false)).resolves.toEqual({ revisionId: 'revision' });
  expect(books.verifyFileAccess).toHaveBeenCalledWith(5, user);
  for (const fresh of [null, { ...user, active: false }, { ...user, permissions: [] }, { ...user, tokenVersion: 3 }]) {
    users.findByIdWithPermissions.mockResolvedValue(fresh);
    await expect(check()).rejects.toBeInstanceOf(ForbiddenException);
  }
});

it('rejects a moved file and cancelled transfer on subsequent checks', async () => {
  let cancelled = false;
  await service.download(3, 5, 'revision', user, () => cancelled);
  books.verifyFileAccess.mockResolvedValue({ libraryId: 4 });
  await expect(check()).rejects.toBeInstanceOf(ForbiddenException);
  cancelled = true;
  await expect(check()).rejects.toBeInstanceOf(ServiceUnavailableException);
});
