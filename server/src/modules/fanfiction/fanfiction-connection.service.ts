import { personalAccessIssueFilter } from './fanfiction-source-filters';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { FanfictionConnection, FanfictionConnectionSettings, FanfictionConnectionDocument, FanfictionWebsite } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionVaultService } from './fanfiction-vault.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { SaveFanfictionConnectionDto } from './dto/fanfiction-connection.dto';
import { mergeFanfictionCookies, mergeRenewedCookies, validateRuntimeCookies, type FanfictionCookieSink } from './fanfiction-cookies';
import { withFanfictionDefaults } from './fanfiction-defaults';
import { fanfictionWebsite, isConnectionAccessError } from './fanfiction-website';

const connections = schema.fanfictionConnections;
const sources = schema.fanfictionSources;

@Injectable()
export class FanfictionConnectionService {
  private readonly logger = new Logger(FanfictionConnectionService.name);
  private catalog?: { expires: number; items: FanfictionWebsite[] };
  private sections = new Map<string, string>();

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly vault: FanfictionVaultService,
    private readonly runtime: FanficfareRuntimeService,
    private readonly access: FanfictionAccessService,
  ) {}

  async websites(): Promise<FanfictionWebsite[]> {
    if (!this.catalog || this.catalog.expires < Date.now()) {
      const catalog = await this.runtime.sites();
      this.sections = new Map(catalog.sites.map((site) => [site.id.replace(/^www\./, ''), site.id]));
      this.catalog = { expires: Date.now() + 300_000, items: catalog.sites.map(fanfictionWebsite) };
    }
    return this.catalog.items;
  }

  private async website(site: string) {
    const website = (await this.websites()).find((item) => item.id === site);
    if (!website) throw new BadRequestException('Website is not supported by the installed downloader');
    return website;
  }

  async list(user: RequestUser): Promise<FanfictionConnection[]> {
    const rows = await this.db.select().from(connections).where(eq(connections.userId, user.id)).orderBy(asc(connections.site));
    const sites = new Map((await this.websites()).map((site) => [site.id, site]));
    return rows.map((row) => this.view(row, sites.get(row.site) ?? fanfictionWebsite({ id: row.site, examples: [] })));
  }

  async owned(id: string, user: RequestUser) {
    const [row] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, user.id)))
      .limit(1);
    if (!row) throw new ForbiddenException('This website login is not available to you');
    return row;
  }

  async settings(id: string, user: RequestUser): Promise<FanfictionConnectionSettings> {
    const row = await this.owned(id, user);
    const document = JSON.parse(await this.vault.decrypt(`user:${user.id}`, row.id, row.document)) as FanfictionConnectionDocument;
    return {
      configuration: await this.runtime.mergeConfiguration(document.configuration, undefined, undefined, true),
      tagRules: document.tagRules ?? [],
    };
  }

  async save(dto: SaveFanfictionConnectionDto, user: RequestUser): Promise<FanfictionConnection> {
    const startedAt = Date.now();
    const website = await this.website(dto.site);
    if (website.access !== 'login' && (dto.username !== undefined || dto.password !== undefined))
      throw new BadRequestException('This website uses browser cookies instead of a saved password');
    const tagKeys = (dto.tagRules ?? []).map((rule) => rule.remoteTag.trim().toLowerCase());
    if (new Set(tagKeys).size !== tagKeys.length) throw new BadRequestException('Use each remote tag only once');
    this.logger.log(`[fanfiction.connection] [start] userId=${user.id} - saving website login`);
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fanfiction-connection:${user.id}:${dto.site}`}, 0))`);
        const [previous] = await tx
          .select()
          .from(connections)
          .where(and(eq(connections.userId, user.id), eq(connections.site, dto.site)))
          .for('update');
        if (previous && dto.version !== previous.version) throw new ConflictException('Website login changed; reload before saving');
        if (!previous && dto.version !== undefined) throw new ConflictException('Website login was removed; reload before saving');
        const id = previous?.id ?? randomUUID();
        const old: FanfictionConnectionDocument = previous
          ? JSON.parse(await this.vault.decrypt(`user:${user.id}`, id, previous.document))
          : { configuration: '', cookies: [] };
        const configuration = await this.runtime.mergeConfiguration(old.configuration, dto.configuration, {
          section: this.sections.get(website.id) ?? website.id,
          ...(dto.username !== undefined ? { username: dto.username } : {}),
          ...(dto.password !== undefined ? { password: dto.password } : {}),
        });
        const cookies = mergeFanfictionCookies(old.cookies, dto.cookies);
        const hosts = new Set([website.id, ...website.examples.map((url) => new URL(url).hostname.replace(/^www\./, ''))]);
        if (
          (dto.cookies ?? []).some(
            (cookie) =>
              ![...hosts].some((host) => host === cookie.domain.replace(/^\./, '') || cookie.domain.replace(/^\./, '').endsWith(`.${host}`)),
          )
        )
          throw new BadRequestException('Cookies must belong to this website');
        const [existing] = await tx.execute(sql`select exists(select 1 from ${connections}) as present`).then((result) => result.rows);
        const document = await this.vault.encrypt(
          `user:${user.id}`,
          id,
          JSON.stringify({ configuration, cookies, tagRules: dto.tagRules ?? old.tagRules ?? [] }),
          !existing?.present,
        );
        const values = {
          document,
          hasPassword: /^[ \t]*password[ \t]*[:=][ \t]*\S/m.test(configuration),
          cookieCount: cookies.length,
          lastSuccessfulAt: null,
          errorCode: null,
          updatedAt: new Date(),
        };
        const [row] = previous
          ? await tx
              .update(connections)
              .set({ ...values, version: previous.version + 1, credentialGeneration: previous.credentialGeneration + 1 })
              .where(eq(connections.id, id))
              .returning()
          : await tx
              .insert(connections)
              .values({ ...values, id, userId: user.id, site: website.id })
              .returning();
        this.logger.log(
          `[fanfiction.connection] [end] connectionId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} - website login saved`,
        );
        return this.view(row, website);
      });
    } catch (error) {
      this.logger.warn(
        `[fanfiction.connection] [fail] userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=ConnectionSaveError error="website login could not be saved" - save failed`,
      );
      throw error;
    }
  }

  async remove(id: string, user: RequestUser) {
    await this.owned(id, user);
    const startedAt = Date.now();
    this.logger.log(`[fanfiction.connection] [start] connectionId=${id} userId=${user.id} - removing website login`);
    await this.db.delete(connections).where(and(eq(connections.id, id), eq(connections.userId, user.id)));
    this.logger.log(
      `[fanfiction.connection] [end] connectionId=${id} userId=${user.id} durationMs=${Date.now() - startedAt} - website login removed`,
    );
  }

  async issues(libraryId: number, user: RequestUser) {
    await this.access.administer(user, libraryId);
    return this.db
      .select({ site: sources.site, count: sql<number>`count(*)::int`, connectionId: connections.id })
      .from(sources)
      .leftJoin(connections, and(eq(connections.userId, user.id), eq(connections.site, sources.site)))
      .where(and(eq(sources.libraryId, libraryId), personalAccessIssueFilter(user.id)))
      .groupBy(sources.site, connections.id)
      .orderBy(asc(sources.site));
  }

  async session(url: string, user: RequestUser, authorize: () => Promise<unknown>) {
    const [recognized] = await this.runtime.recognize([url]);
    if (!recognized?.recognized)
      throw new BadRequestException({ message: 'Story website could not be recognized', errorCode: 'source_unrecognized' });
    const site = recognized.site.replace(/^www\./, '');
    const [row] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.site, site), eq(connections.userId, user.id)))
      .limit(1);
    if (!row) return { document: withFanfictionDefaults({ configuration: '', cookies: [] }, user), saveCookies: undefined, connection: null };
    const original = JSON.parse(await this.vault.decrypt(`user:${user.id}`, row.id, row.document)) as FanfictionConnectionDocument;
    const saveCookies: FanfictionCookieSink = async (incoming) => {
      const cookies = validateRuntimeCookies(incoming);
      await this.db.transaction(async (tx) => {
        await authorize();
        const [current] = await tx
          .select()
          .from(connections)
          .where(and(eq(connections.id, row.id), eq(connections.userId, user.id)))
          .for('update');
        if (!current || current.credentialGeneration !== row.credentialGeneration)
          throw new ConflictException('Website login changed during download');
        const document = JSON.parse(await this.vault.decrypt(`user:${user.id}`, row.id, current.document)) as FanfictionConnectionDocument;
        const merged = mergeRenewedCookies(original.cookies, document.cookies, cookies);
        await tx
          .update(connections)
          .set({
            document: await this.vault.encrypt(`user:${user.id}`, row.id, JSON.stringify({ ...document, cookies: merged }), false),
            cookieCount: merged.length,
          })
          .where(eq(connections.id, row.id));
        original.cookies = merged;
      });
    };
    return { document: withFanfictionDefaults(original, user), saveCookies, connection: { id: row.id, generation: row.credentialGeneration } };
  }

  async outcome(connection: { id: string; generation: number }, userId: number, errorCode?: string) {
    if (errorCode && !isConnectionAccessError(errorCode)) return;
    await this.db
      .update(connections)
      .set(errorCode ? { errorCode } : { errorCode: null, lastSuccessfulAt: new Date() })
      .where(and(eq(connections.id, connection.id), eq(connections.userId, userId), eq(connections.credentialGeneration, connection.generation)));
  }

  private view(row: typeof connections.$inferSelect, website: FanfictionWebsite): FanfictionConnection {
    return {
      id: row.id,
      website,
      version: row.version,
      hasPassword: row.hasPassword,
      cookieCount: row.cookieCount,
      lastSuccessfulAt: row.lastSuccessfulAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
