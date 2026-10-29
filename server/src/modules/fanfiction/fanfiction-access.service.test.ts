import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Permission } from '@bookorbit/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { LibraryRepository } from '../library/library.repository';
import { UserService } from '../user/user.service';
import { FanfictionAccessService } from './fanfiction-access.service';

describe('Fanfiction library administration scope', () => {
  const user = { id: 7, active: true, tokenVersion: 2, isSuperuser: false, permissions: [Permission.ManageLibraries] } as RequestUser;
  const users = { findByIdWithPermissions: vi.fn() };
  const libraries = { findById: vi.fn(), findUserAccess: vi.fn(), findAdministrable: vi.fn() };
  let access: FanfictionAccessService;
  beforeEach(async () => {
    vi.resetAllMocks();
    users.findByIdWithPermissions.mockResolvedValue(user);
    libraries.findById.mockResolvedValue([{ id: 5 }]);
    libraries.findUserAccess.mockResolvedValue({ accessLevel: 'owner' });
    libraries.findAdministrable.mockResolvedValue([{ id: 5, name: 'Stories' }]);
    const module = await Test.createTestingModule({
      providers: [
        FanfictionAccessService,
        LibraryService,
        { provide: UserService, useValue: users },
        { provide: LibraryRepository, useValue: libraries },
        { provide: ConfigService, useValue: { get: () => '/tmp' } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    access = module.get(FanfictionAccessService);
  });
  it('requires both library ownership and administration permission', async () => {
    await expect(access.administer(user, 5)).resolves.toBeUndefined();
    libraries.findUserAccess.mockResolvedValueOnce({ accessLevel: 'editor' });
    await expect(access.administer(user, 5)).rejects.toThrow('administration');
    users.findByIdWithPermissions.mockResolvedValueOnce({ ...user, permissions: [] });
    await expect(access.administer(user, 5)).rejects.toThrow('administration');
  });
  it('rechecks inactive accounts and revoked sessions and bounds library pages', async () => {
    users.findByIdWithPermissions.mockResolvedValueOnce({ ...user, active: false });
    await expect(access.administer(user, 5)).rejects.toThrow('no longer');
    users.findByIdWithPermissions.mockResolvedValueOnce({ ...user, tokenVersion: 3 });
    await expect(access.administer(user, 5)).rejects.toThrow('no longer');
    expect(await access.librariesFor(user, 10, 50)).toEqual({ items: [{ id: 5, name: 'Stories' }], nextCursor: null });
    expect(libraries.findAdministrable).toHaveBeenCalledWith(7, false, 10, 51);
  });
});
