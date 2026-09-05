import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { FanfictionProfileDocument, FanfictionProfileSummary, FanfictionProfileView } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionVaultService } from './fanfiction-vault.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { CreateFanfictionProfileDto, ListFanfictionProfilesDto, UpdateFanfictionProfileDto } from './dto/fanfiction-profile.dto';

const profiles = schema.fanfictionProfiles;
const summaryFields = {
  id: profiles.id,
  libraryId: profiles.libraryId,
  name: profiles.name,
  version: profiles.version,
  updatedAt: profiles.updatedAt,
};

@Injectable()
export class FanfictionProfileService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly vault: FanfictionVaultService,
    private readonly runtime: FanficfareRuntimeService,
  ) {}

  async list(libraryId: number, dto: ListFanfictionProfilesDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const rows = await this.db
      .select(summaryFields)
      .from(profiles)
      .where(and(eq(profiles.libraryId, libraryId), dto.cursor ? gt(profiles.id, dto.cursor) : undefined))
      .orderBy(asc(profiles.id))
      .limit(dto.limit + 1);
    const items = rows.slice(0, dto.limit).map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
    return { items, nextCursor: rows.length > dto.limit ? items[items.length - 1].id : null };
  }

  async get(libraryId: number, id: string, user: RequestUser): Promise<FanfictionProfileView> {
    const { row, document } = await this.document(libraryId, id, user);
    const configuration = await this.runtime.mergeConfiguration(document.configuration, undefined, undefined, true);
    return { ...this.summary(row), configuration, cookieCount: document.cookies.length };
  }

  async create(libraryId: number, dto: CreateFanfictionProfileDto, user: RequestUser): Promise<FanfictionProfileSummary> {
    await this.access.administer(user, libraryId);
    const configuration = await this.runtime.mergeConfiguration('', dto.configuration, dto.credentials);
    const id = randomUUID();
    const [existing] = await this.db.select({ id: profiles.id }).from(profiles).limit(1);
    const document = await this.vault.encrypt(libraryId, id, JSON.stringify({ configuration, cookies: dto.cookies ?? [] }), !existing);
    await this.access.administer(user, libraryId);
    const [row] = await this.db.insert(profiles).values({ id, libraryId, name: dto.name, createdBy: user.id, document }).returning(summaryFields);
    return this.summary(row);
  }

  async update(libraryId: number, id: string, dto: UpdateFanfictionProfileDto, user: RequestUser): Promise<FanfictionProfileSummary> {
    const old = await this.document(libraryId, id, user);
    if (old.row.version !== dto.version) throw new ConflictException('Profile changed; reload before saving');
    const configuration = await this.runtime.mergeConfiguration(old.document.configuration, dto.configuration, dto.credentials);
    const document = await this.vault.encrypt(libraryId, id, JSON.stringify({ configuration, cookies: dto.cookies ?? old.document.cookies }), false);
    await this.access.administer(user, libraryId);
    const [row] = await this.db
      .update(profiles)
      .set({ name: dto.name, document, version: dto.version + 1, updatedAt: new Date() })
      .where(and(eq(profiles.id, id), eq(profiles.libraryId, libraryId), eq(profiles.version, dto.version)))
      .returning(summaryFields);
    if (!row) throw new ConflictException('Profile changed; reload before saving');
    return this.summary(row);
  }

  async document(libraryId: number, id: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const [row] = await this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.libraryId, libraryId), eq(profiles.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Fanfiction profile not found in this library');
    const document = JSON.parse(await this.vault.decrypt(libraryId, id, row.document)) as FanfictionProfileDocument;
    return { row, document };
  }

  private summary(row: Pick<typeof profiles.$inferSelect, 'id' | 'libraryId' | 'name' | 'version' | 'updatedAt'>): FanfictionProfileSummary {
    return { id: row.id, libraryId: row.libraryId, name: row.name, version: row.version, updatedAt: row.updatedAt.toISOString() };
  }
}
