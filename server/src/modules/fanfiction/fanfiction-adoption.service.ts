import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'node:crypto';
import type { FanfictionDiscoverySelection } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import { DB } from '../../db';
import type { DatabaseTransaction } from '../../db/transaction';
import * as schema from '../../db/schema';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { RevisionFileService } from '../book-revision/revision-file.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { SelectFanfictionDiscoveryDto } from './dto/fanfiction-discovery.dto';

const candidates = schema.fanfictionDiscoveryCandidates;
const jobs = schema.fanfictionJobs;
const sources = schema.fanfictionSources;

@Injectable()
export class FanfictionAdoptionService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly jobs: FanfictionJobService,
    private readonly profiles: FanfictionProfileService,
    private readonly catalog: RevisionCatalogService,
    private readonly revisions: BookRevisionService,
    private readonly files: RevisionFileService,
  ) {}

  async start(libraryId: number, dto: SelectFanfictionDiscoveryDto, user: RequestUser) {
    await this.access.administer(user, libraryId);
    if (Boolean(dto.ids?.length) === Boolean(dto.allMatching)) throw new BadRequestException('Choose explicit candidates or all matching candidates');
    if (dto.canonicalUrl && (dto.ids?.length !== 1 || dto.allMatching))
      throw new BadRequestException('Choose an ambiguous source for one candidate at a time');
    if (dto.decision === 'approve' && dto.state === 'ambiguous' && !dto.canonicalUrl)
      throw new BadRequestException('Ambiguous candidates need an explicit source choice');
    if (dto.profileId) await this.profiles.get(libraryId, dto.profileId, user);
    const {
      rows: [{ cutoff }],
    } = await this.db.execute<{ cutoff: string }>(sql`select to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as cutoff`);
    const selection: FanfictionDiscoverySelection = {
      cutoff,
      cursor: null,
      ids: dto.ids ? [...new Set(dto.ids)].sort() : null,
      state: dto.state,
      decision: dto.decision,
      profileId: dto.profileId ?? null,
      intervalMinutes: dto.intervalMinutes === undefined ? 1440 : dto.intervalMinutes,
      canonicalUrl: dto.canonicalUrl,
      processed: 0,
      failed: 0,
    };
    const [inserted] = await this.db
      .insert(jobs)
      .values({
        libraryId,
        userId: user.id,
        tokenVersion: user.tokenVersion,
        idempotencyKey: dto.idempotencyKey,
        kind: 'adopt',
        profileId: dto.profileId ?? null,
        url: '',
        site: `local-library-${libraryId}`,
        selection,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return this.jobs.get(libraryId, inserted.id, user);
    const [existing] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.libraryId, libraryId), eq(jobs.userId, user.id), eq(jobs.idempotencyKey, dto.idempotencyKey)))
      .limit(1);
    const previous = existing?.selection;
    if (
      existing?.kind !== 'adopt' ||
      !previous ||
      previous.decision !== selection.decision ||
      previous.state !== selection.state ||
      previous.profileId !== selection.profileId ||
      previous.intervalMinutes !== selection.intervalMinutes ||
      previous.canonicalUrl !== selection.canonicalUrl ||
      JSON.stringify(previous.ids) !== JSON.stringify(selection.ids)
    )
      throw new ConflictException('Operation identity was reused with different input');
    return this.jobs.get(libraryId, existing.id, user);
  }

  async run(job: typeof jobs.$inferSelect, user: RequestUser, authorize: () => Promise<unknown>, signal: AbortSignal) {
    if (!job.selection) throw new BadRequestException('Adoption has no saved selection');
    const selection = { ...job.selection };
    if (selection.profileId) {
      try {
        await this.profiles.get(job.libraryId, selection.profileId, user);
      } catch (error) {
        if (error instanceof NotFoundException)
          throw new BadRequestException({ errorCode: 'configuration_blocked', message: 'The selected profile is no longer available' });
        throw error;
      }
    }
    const batch = await this.db
      .select()
      .from(candidates)
      .where(
        and(
          eq(candidates.libraryId, job.libraryId),
          sql`${candidates.createdAt} <= ${selection.cutoff}::timestamptz`,
          selection.cursor ? gt(candidates.id, selection.cursor) : undefined,
          selection.retryFailedOnly
            ? and(eq(candidates.reviewJobId, job.id), eq(candidates.state, 'failed'))
            : selection.ids
              ? inArray(candidates.id, selection.ids)
              : and(eq(candidates.state, selection.state), sql`${candidates.updatedAt} <= ${selection.cutoff}::timestamptz`),
        ),
      )
      .orderBy(asc(candidates.id))
      .limit(100);
    const deadline = Date.now() + 20_000;
    for (const candidate of batch) {
      if (signal.aborted) throw new ConflictException('Discovery selection was cancelled');
      await authorize();
      const checkpoint = async (tx: DatabaseTransaction, failed: boolean) => {
        selection.cursor = candidate.id;
        selection.processed++;
        if (failed) selection.failed++;
        await tx
          .update(jobs)
          .set({
            selection,
            result: { selection: { processed: selection.processed, failed: selection.failed, finished: false } },
            updatedAt: sql`now()`,
          })
          .where(eq(jobs.id, job.id));
      };
      try {
        if (candidate.state !== (selection.retryFailedOnly ? 'failed' : selection.state))
          throw new ConflictException('Candidate review state changed');
        if (selection.decision === 'approve') await this.adopt(job, candidate, selection, authorize, (tx) => checkpoint(tx, false));
        else
          await this.db.transaction(async (tx) => {
            await this.jobs.assertOwnership(job, tx);
            await authorize();
            const rows = await tx
              .update(candidates)
              .set({ state: 'rejected', reviewJobId: job.id, errorCode: null, version: candidate.version + 1, updatedAt: sql`now()` })
              .where(and(eq(candidates.id, candidate.id), eq(candidates.version, candidate.version), eq(candidates.state, candidate.state)))
              .returning({ id: candidates.id });
            if (!rows.length) throw new ConflictException('Candidate changed before rejection');
            await checkpoint(tx, false);
          });
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof BadRequestException || error instanceof NotFoundException)) throw error;
        const response = error.getResponse();
        const errorCode =
          typeof response === 'object' && 'errorCode' in response && typeof response.errorCode === 'string'
            ? response.errorCode
            : 'candidate_changed';
        await this.db.transaction(async (tx) => {
          await this.jobs.assertOwnership(job, tx);
          await authorize();
          await tx
            .update(candidates)
            .set({ state: 'failed', reviewJobId: job.id, errorCode, version: candidate.version + 1, updatedAt: sql`now()` })
            .where(
              and(
                eq(candidates.id, candidate.id),
                eq(candidates.version, candidate.version),
                inArray(candidates.state, ['pending', 'ambiguous', 'failed']),
              ),
            );
          await checkpoint(tx, true);
        });
      }
      if (Date.now() >= deadline) break;
    }
    return {
      selection: {
        processed: selection.processed,
        failed: selection.failed,
        finished: !batch.length || (batch.length < 100 && selection.cursor === batch.at(-1)!.id),
      },
    };
  }

  private async adopt(
    job: typeof jobs.$inferSelect,
    candidate: typeof candidates.$inferSelect,
    selection: FanfictionDiscoverySelection,
    authorize: () => Promise<unknown>,
    complete: (tx: DatabaseTransaction) => Promise<void>,
  ) {
    const choices = candidate.urls.filter((url) => url.recognized);
    const unique = new Map(choices.map((url) => [url.canonicalUrl, url]));
    const choice = selection.canonicalUrl ? unique.get(selection.canonicalUrl) : unique.size === 1 ? [...unique.values()][0] : undefined;
    if (!choice) throw new ConflictException({ errorCode: 'source_ambiguous', message: 'Choose one verified source URL before linking this book' });
    const file = await this.catalog.fileLocation(candidate.bookFileId, job.libraryId);
    if (file.bookId !== candidate.bookId) throw new ConflictException('Candidate book assignment changed');
    const inspection = await this.files.inspect(file.absolutePath);
    if (inspection.status !== 'stable')
      throw new ConflictException({ errorCode: 'candidate_unavailable', message: 'The EPUB is unavailable or changing; scan it again when stable' });
    const inspected = inspection.file;
    if (inspected.sha256 !== candidate.sha256)
      throw new ConflictException({ errorCode: 'candidate_changed', message: 'The EPUB changed after discovery; scan its current contents again' });
    await this.revisions.observeFile(file.id, {});
    await this.db.transaction(async (tx) => {
      await this.jobs.assertOwnership(job, tx);
      await authorize();
      const [current] = await tx.select().from(candidates).where(eq(candidates.id, candidate.id)).for('update');
      if (!current || current.version !== candidate.version || current.state !== candidate.state)
        throw new ConflictException('Candidate changed before linking');
      await this.catalog.lockFileLocation(tx, job.libraryId, file);
      await this.files.verifyUnchanged(file.absolutePath, inspected);
      const canonicalKey = createHash('sha256').update(choice.canonicalUrl).digest('hex');
      const [assigned] = await tx
        .select({ canonicalKey: sources.canonicalKey })
        .from(sources)
        .where(and(eq(sources.bookFileId, file.id), sql`${sources.state} <> 'unlinked'`))
        .limit(1);
      if (assigned && assigned.canonicalKey !== canonicalKey)
        throw new ConflictException({ errorCode: 'source_conflict', message: 'This EPUB already has another source' });
      await tx
        .insert(sources)
        .values({
          libraryId: job.libraryId,
          createdBy: job.userId,
          folderId: file.libraryFolderId,
          profileId: selection.profileId,
          bookId: file.bookId,
          bookFileId: file.id,
          canonicalUrl: choice.canonicalUrl,
          canonicalKey,
          site: new URL(choice.canonicalUrl).hostname.replace(/^www\./, ''),
          title: candidate.title,
          authors: candidate.authors,
          chapterCount: candidate.chapterCount,
          state: 'active',
          intervalMinutes: selection.intervalMinutes,
          nextCheckAt: selection.intervalMinutes === null ? null : sql`now() + (${selection.intervalMinutes} * interval '1 minute')`,
          importOperationId: randomUUID(),
          relativePath: file.relPath ?? '',
        })
        .onConflictDoNothing();
      const [source] = await tx
        .select()
        .from(sources)
        .where(and(eq(sources.libraryId, job.libraryId), eq(sources.canonicalKey, canonicalKey)))
        .for('update');
      if (!source || source.bookFileId !== file.id || source.state === 'pending')
        throw new ConflictException({ errorCode: 'source_conflict', message: 'This story or EPUB already has another source reservation' });
      if (source.state === 'unlinked')
        await tx
          .update(sources)
          .set({
            state: 'active',
            profileId: selection.profileId,
            intervalMinutes: selection.intervalMinutes,
            nextCheckAt: selection.intervalMinutes === null ? null : sql`now() + (${selection.intervalMinutes} * interval '1 minute')`,
            attentionCode: null,
            version: source.version + 1,
            updatedAt: sql`now()`,
          })
          .where(eq(sources.id, source.id));
      await tx
        .update(candidates)
        .set({ state: 'linked', reviewJobId: job.id, sourceId: source.id, version: current.version + 1, errorCode: null, updatedAt: sql`now()` })
        .where(eq(candidates.id, candidate.id));
      await complete(tx);
    });
  }
}
