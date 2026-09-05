import { ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { UserService } from '../user/user.service';

@Injectable()
export class FanfictionAccessService {
  constructor(
    private readonly users: UserService,
    private readonly libraries: LibraryService,
  ) {}

  async administer(user: RequestUser, libraryId: number): Promise<void> {
    const fresh = await this.users.findByIdWithPermissions(user.id);
    if (!fresh?.active || fresh.tokenVersion !== user.tokenVersion)
      throw new ForbiddenException('Fanfiction administration access is no longer available');
    await this.libraries.verifyAdministration(fresh, libraryId);
  }

  async librariesFor(user: RequestUser, afterId: number, limit: number) {
    const fresh = await this.users.findByIdWithPermissions(user.id);
    if (!fresh?.active || fresh.tokenVersion !== user.tokenVersion)
      throw new ForbiddenException('Fanfiction administration access is no longer available');
    return this.libraries.findAdministrable(fresh, afterId, limit);
  }
}
