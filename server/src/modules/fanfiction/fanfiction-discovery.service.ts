import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FanfictionDiscoveryPage, FanfictionDiscoveryProgress } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { RevisionFileService } from '../book-revision/revision-file.service';
import { EpubManifestService } from '../book-revision/epub-manifest.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { ListFanfictionDiscoveryDto } from './dto/fanfiction-discovery.dto';

const candidates = schema.fanfictionDiscoveryCandidates;
const jobs = schema.fanfictionJobs;

@Injectable()
export class FanfictionDiscoveryService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly jobs: FanfictionJobService,
    private readonly catalog: RevisionCatalogService,
    private readonly files: RevisionFileService,
    private readonly manifests: EpubManifestService,
    private readonly runtime: FanficfareRuntimeService,
  ) {}

  async start(libraryId: number, idempotencyKey: string, user: RequestUser) {
    await this.access.administer(user, libraryId);
    const discovery: FanfictionDiscoveryProgress = {
      cutoffFileId: await this.catalog.discoveryCutoff(libraryId),
      cursorFileId: 0,
      scanned: 0,
      candidates: 0,
      failed: 0,
      finished: false,
    };
    const [inserted] = await this.db
      .insert(jobs)
      .values({
        libraryId,
        userId: user.id,
        tokenVersion: user.tokenVersion,
        idempotencyKey,
        kind: 'discovery',
        url: '',
        site: `local-library-${libraryId}`,
        discovery,
        result: { discovery },
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return this.jobs.get(libraryId, inserted.id, user);
    const [existing] = await this.db
      .select({ id: jobs.id, kind: jobs.kind })
      .from(jobs)
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.userId, user.id), eq(jobs.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) {
      if (existing.kind !== 'discovery') throw new ConflictException('Operation identity was reused with different input');
      return this.jobs.get(libraryId, existing.id, user);
    }
    throw new ConflictException('A discovery scan for this library is already active');
  }

  async list(libraryId: number, dto: ListFanfictionDiscoveryDto, user: RequestUser): Promise<FanfictionDiscoveryPage> {
    await this.access.administer(user, libraryId);
    if (dto.cursor) {
      const [cursor] = await this.db
        .select({ id: candidates.id })
        .from(candidates)
        .where(and(eq(candidates.id, dto.cursor), eq(candidates.libraryId, libraryId)))
        .limit(1);
      if (!cursor) throw new BadRequestException('Discovery cursor does not belong to this library');
    }
    const rows = await this.db
      .select({
        id: candidates.id,
        libraryId: candidates.libraryId,
        bookId: candidates.bookId,
        bookFileId: candidates.bookFileId,
        sha256: candidates.sha256,
        title: candidates.title,
        authors: candidates.authors,
        chapterCount: candidates.chapterCount,
        urls: candidates.urls,
        state: candidates.state,
        errorCode: candidates.errorCode,
        sourceId: candidates.sourceId,
        reviewJobId: candidates.reviewJobId,
        version: candidates.version,
        createdAt: candidates.createdAt,
      })
      .from(candidates)
      .where(and(eq(candidates.libraryId, libraryId), eq(candidates.state, dto.state), dto.cursor ? gt(candidates.id, dto.cursor) : undefined))
      .orderBy(asc(candidates.id))
      .limit(dto.limit + 1);
    const items = rows.slice(0, dto.limit).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return { items, nextCursor: rows.length > dto.limit ? items.at(-1)!.id : null };
  }

  async run(job: typeof jobs.$inferSelect, authorize: () => Promise<unknown>, signal: AbortSignal) {
    if (!job.discovery) throw new BadRequestException('Discovery scan has no durable cursor');
    const progress = { ...job.discovery };
    const batch = await this.catalog.discoveryFiles(job.libraryId, progress.cursorFileId, progress.cutoffFileId);
    const owned = batch.length
      ? await this.db
          .select({ bookFileId: schema.fanfictionSources.bookFileId })
          .from(schema.fanfictionSources)
          .where(
            and(
              inArray(
                schema.fanfictionSources.bookFileId,
                batch.map((file) => file.id),
              ),
              sql`${schema.fanfictionSources.state} <> 'unlinked'`,
            ),
          )
      : [];
    const assigned = new Set(owned.map((row) => row.bookFileId));
    const deadline = Date.now() + 20_000;
    for (const file of batch) {
      if (signal.aborted) throw new ConflictException('Discovery scan was cancelled');
      await authorize();
      let candidate: typeof candidates.$inferInsert | undefined;
      let inspected: Awaited<ReturnType<RevisionFileService['require']>> | undefined;
      let failed = false;
      if (!assigned.has(file.id)) {
        try {
          const inspection = await this.files.inspect(file.absolutePath);
          if (inspection.status !== 'stable') throw new BadRequestException('Discovery file is unavailable or changing');
          inspected = inspection.file;
          const evidence = await this.manifests.sourceEvidence(file.absolutePath);
          if (evidence.sourceUrls.length || evidence.fanficfare) {
            const urls = evidence.sourceUrls.length
              ? await this.runtime.recognize(
                  evidence.sourceUrls.map((url) => url.replace(/^http:\/\//i, 'https://')),
                  signal,
                )
              : [];
            const recognized = new Set(urls.filter((url) => url.recognized).map((url) => url.canonicalUrl));
            if (recognized.size || evidence.fanficfare)
              candidate = {
                libraryId: job.libraryId,
                bookId: file.bookId,
                bookFileId: file.id,
                sha256: inspected.sha256,
                title: evidence.title,
                authors: evidence.authors,
                chapterCount: evidence.chapterCount,
                urls,
                state: recognized.size === 1 ? 'pending' : recognized.size > 1 ? 'ambiguous' : 'failed',
                errorCode: recognized.size ? null : 'source_unrecognized',
              };
          }
          await this.files.verifyUnchanged(file.absolutePath, inspected);
        } catch (error) {
          if (!(error instanceof BadRequestException || error instanceof ConflictException)) throw error;
          const response = error.getResponse();
          if (typeof response === 'object' && 'errorCode' in response) throw error;
          failed = true;
          candidate = undefined;
        }
      }
      await this.db.transaction(async (tx) => {
        await this.jobs.assertOwnership(job, tx);
        await authorize();
        if (candidate && inspected) {
          await this.catalog.lockDiscoveryFile(tx, job.libraryId, file);
          await this.files.verifyUnchanged(file.absolutePath, inspected);
          const inserted = await tx.insert(candidates).values(candidate).onConflictDoNothing().returning({ id: candidates.id });
          if (inserted.length) progress.candidates++;
        }
        progress.cursorFileId = file.id;
        progress.scanned++;
        if (failed) progress.failed++;
        await tx
          .update(jobs)
          .set({ discovery: progress, result: { discovery: progress }, updatedAt: sql`now()` })
          .where(eq(jobs.id, job.id));
      });
      if (Date.now() >= deadline) break;
    }
    progress.finished = !batch.length || (batch.length < 100 && progress.cursorFileId === batch.at(-1)!.id);
    return { discovery: progress };
  }
}
