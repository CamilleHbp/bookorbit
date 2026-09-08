import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
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
import {
  mergeFanfictionCookies,
  mergeRenewedCookies,
  redactFanfictionCookies,
  validateRuntimeCookies,
  type FanfictionCookieSink,
} from './fanfiction-cookies';

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
  private readonly logger = new Logger(FanfictionProfileService.name);
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
    return { ...this.summary(row), configuration, cookieCount: document.cookies.length, cookies: redactFanfictionCookies(document.cookies) };
  }

  async create(libraryId: number, dto: CreateFanfictionProfileDto, user: RequestUser): Promise<FanfictionProfileSummary> {
    await this.access.administer(user, libraryId);
    const configuration = await this.runtime.mergeConfiguration('', dto.configuration, dto.credentials);
    const id = randomUUID();
    const [existing] = await this.db.select({ id: profiles.id }).from(profiles).limit(1);
    const document = await this.vault.encrypt(
      libraryId,
      id,
      this.serialize({ configuration, cookies: mergeFanfictionCookies([], dto.cookies) }),
      !existing,
    );
    await this.access.administer(user, libraryId);
    const [row] = await this.db.insert(profiles).values({ id, libraryId, name: dto.name, createdBy: user.id, document }).returning(summaryFields);
    return this.summary(row);
  }

  async update(libraryId: number, id: string, dto: UpdateFanfictionProfileDto, user: RequestUser): Promise<FanfictionProfileSummary> {
    const old = await this.document(libraryId, id, user);
    if (old.row.version !== dto.version) throw new ConflictException('Profile changed; reload before saving');
    const configuration = await this.runtime.mergeConfiguration(old.document.configuration, dto.configuration, dto.credentials);
    const document = await this.vault.encrypt(
      libraryId,
      id,
      this.serialize({ configuration, cookies: mergeFanfictionCookies(old.document.cookies, dto.cookies) }),
      false,
    );
    await this.access.administer(user, libraryId);
    const [row] = await this.db
      .update(profiles)
      .set({ name: dto.name, document, version: dto.version + 1, credentialGeneration: old.row.credentialGeneration + 1, updatedAt: new Date() })
      .where(and(eq(profiles.id, id), eq(profiles.libraryId, libraryId), eq(profiles.version, dto.version)))
      .returning(summaryFields);
    if (!row) throw new ConflictException('Profile changed; reload before saving');
    return this.summary(row);
  }

  async remove(libraryId: number, id: string, user: RequestUser): Promise<void> {
    const started = Date.now();
    const fields = `libraryId=${libraryId} profileId=${id} userId=${user.id}`;
    this.logger.log(`[fanfiction-profile-delete] [start] ${fields} - Deleting profile`);
    try {
      await this.access.administer(user, libraryId);
      await this.db.transaction(async (tx) => {
        const [profile] = await tx
          .select({ id: profiles.id })
          .from(profiles)
          .where(and(eq(profiles.libraryId, libraryId), eq(profiles.id, id)))
          .for('update');
        if (!profile) throw new NotFoundException('Fanfiction profile not found in this library');
        const sources = schema.fanfictionSources;
        const jobs = schema.fanfictionJobs;
        // Older adoption jobs only stored the profile in their selection.
        const jobProfile = or(eq(jobs.profileId, id), and(eq(jobs.kind, 'adopt'), sql`${jobs.selection}->>'profileId' = ${id}`));
        const [source] = await tx
          .select({ id: sources.id })
          .from(sources)
          .where(and(eq(sources.libraryId, libraryId), eq(sources.profileId, id), ne(sources.state, 'unlinked')))
          .limit(1);
        if (source)
          throw new ConflictException(
            'This profile is assigned to stories. Choose another profile or Public access in each story’s Updates settings before deleting it.',
          );
        await tx
          .update(sources)
          .set({ profileId: null })
          .where(and(eq(sources.libraryId, libraryId), eq(sources.profileId, id), eq(sources.state, 'unlinked')));
        await tx
          .update(jobs)
          .set({
            profileId: null,
            errorCode: sql`case when ${jobs.state} in ('failed', 'cancelled') then 'profile_deleted' else ${jobs.errorCode} end`,
          })
          .where(and(eq(jobs.libraryId, libraryId), jobProfile, inArray(jobs.state, ['succeeded', 'no_change', 'failed', 'cancelled'])));
        const [pending] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.libraryId, libraryId), jobProfile, notInArray(jobs.state, ['succeeded', 'no_change', 'failed', 'cancelled'])))
          .limit(1);
        if (pending)
          throw new ConflictException(
            'This profile is needed by an unfinished operation. Finish or cancel it in Activity before deleting the profile.',
          );
        await tx.delete(profiles).where(and(eq(profiles.libraryId, libraryId), eq(profiles.id, id)));
      });
      this.logger.log(`[fanfiction-profile-delete] [end] ${fields} durationMs=${Date.now() - started} deleted=1 - Profile deleted`);
    } catch (error) {
      this.logger.warn(
        `[fanfiction-profile-delete] [fail] ${fields} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : error)}" - Profile deletion failed`,
      );
      const cause = error as { code?: string; cause?: { code?: string } };
      if (cause?.code === '23503' || cause?.cause?.code === '23503')
        throw new ConflictException(
          'This profile is still in use. Refresh and try again after changing the story profile or finishing its activity.',
        );
      throw error;
    }
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

  async session(libraryId: number, id: string, user: RequestUser, authorize: () => Promise<unknown>) {
    const snapshot = await this.document(libraryId, id, user);
    const document = structuredClone(snapshot.document);
    const saveCookies: FanfictionCookieSink = async (incoming) => {
      const cookies = validateRuntimeCookies(incoming);
      const startedAt = Date.now();
      this.logger.log(`[fanfiction.cookies] [start] profileId=${id} libraryId=${libraryId} userId=${user.id} - retaining renewed login cookies`);
      try {
        const merged = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(profiles)
            .where(and(eq(profiles.id, id), eq(profiles.libraryId, libraryId)))
            .for('update');
          if (!row) throw new NotFoundException('Fanfiction profile not found in this library');
          await authorize();
          await this.access.administer(user, libraryId);
          if (row.credentialGeneration !== snapshot.row.credentialGeneration)
            throw new ConflictException({ message: 'Profile credentials changed during the operation', errorCode: 'configuration_blocked' });
          const current = JSON.parse(await this.vault.decrypt(libraryId, id, row.document)) as FanfictionProfileDocument;
          const merged = mergeRenewedCookies(document.cookies, current.cookies, cookies);
          if (JSON.stringify(merged) !== JSON.stringify(current.cookies)) {
            const encrypted = await this.vault.encrypt(libraryId, id, this.serialize({ ...current, cookies: merged }), false);
            await tx
              .update(profiles)
              .set({ document: encrypted, version: row.version + 1, updatedAt: new Date() })
              .where(eq(profiles.id, id));
          }
          return merged;
        });
        document.cookies = merged;
        this.logger.log(
          `[fanfiction.cookies] [end] profileId=${id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} - login cookies retained`,
        );
      } catch (error) {
        this.logger.warn(
          `[fanfiction.cookies] [fail] profileId=${id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} errorClass=CookiePersistenceError error="encrypted session write rejected" - login cookies could not be retained`,
        );
        throw error;
      }
    };
    return { document, saveCookies };
  }

  private serialize(document: FanfictionProfileDocument) {
    const value = JSON.stringify(document);
    // Leave room for the operation and story URL in the bounded runtime request.
    if (Buffer.byteLength(value) > 480 * 1024) throw new BadRequestException('The profile configuration and cookies are too large');
    return value;
  }

  private summary(row: Pick<typeof profiles.$inferSelect, 'id' | 'libraryId' | 'name' | 'version' | 'updatedAt'>): FanfictionProfileSummary {
    return { id: row.id, libraryId: row.libraryId, name: row.name, version: row.version, updatedAt: row.updatedAt.toISOString() };
  }
}
