import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Permission } from '@bookorbit/types';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { UserService } from '../user/user.service';
import { BookReadService } from '../book/book-read.service';
import { KoreaderRepository } from './koreader.repository';

@Injectable()
export class KoreaderDeliveryAccessService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly users: UserService,
    private readonly books: BookReadService,
    private readonly koreader: KoreaderRepository,
  ) {}

  async user(user: RequestUser, download = true) {
    const fresh = await this.users.findByIdWithPermissions(user.id);
    if (
      !fresh?.active ||
      fresh.tokenVersion !== user.tokenVersion ||
      (!fresh.isSuperuser &&
        (!fresh.permissions.includes(Permission.KoreaderSync) || (download && !fresh.permissions.includes(Permission.LibraryDownload))))
    )
      throw new ForbiddenException('Device delivery permission is no longer available');
    const credentials = await this.koreader.findKoreaderUser(user.id);
    if (!credentials?.syncEnabled) throw new ForbiddenException('KOReader synchronization is disabled');
    return fresh;
  }

  async copy(id: string, user: RequestUser, download = true, deviceId?: string) {
    const fresh = await this.user(user, download);
    const c = schema.koreaderInstalledCopies,
      d = schema.koreaderDeliveryDevices;
    const [row] = await this.db
      .select({ copy: c, device: d })
      .from(c)
      .innerJoin(d, and(eq(d.userId, c.userId), eq(d.deviceId, c.deviceId)))
      .where(and(eq(c.id, id), eq(c.userId, fresh.id), deviceId ? eq(c.deviceId, deviceId) : undefined))
      .limit(1);
    if (!row) throw new NotFoundException('Installed copy unavailable');
    const [file] = await this.books.findAccessibleFiles([row.copy.bookFileId], fresh);
    if (!file || !['epub', 'kepub'].includes(file.format ?? '')) throw new NotFoundException('Installed copy unavailable');
    return { ...row, file, user: fresh };
  }
}
