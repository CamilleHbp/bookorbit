import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Readable } from 'node:stream';
import type { FanfictionJob, FanfictionReplacementReview } from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { BookDockManagedUploadService } from '../book-dock/book-dock-managed-upload.service';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { RevisionPublicationService } from '../book-revision/revision-publication.service';
import type { RevisionPublicationAuthority } from '../book-revision/revision-publication-authority';
import { EpubManifestService } from '../book-revision/epub-manifest.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import type { UploadFanfictionReplacementDto } from './dto/fanfiction-replacement.dto';

type Job = typeof schema.fanfictionJobs.$inferSelect;

@Injectable()
export class FanfictionReplacementService {
  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly access: FanfictionAccessService,
    private readonly jobs: FanfictionJobService,
    private readonly sources: FanfictionSourceService,
    private readonly uploads: BookDockManagedUploadService,
    private readonly revisions: BookRevisionService,
    private readonly catalog: RevisionCatalogService,
    private readonly publications: RevisionPublicationService,
    private readonly manifests: EpubManifestService,
    private readonly runtime: FanficfareRuntimeService,
  ) {}

  async upload(libraryId: number, sourceId: string, dto: UploadFanfictionReplacementDto, filename: string, stream: Readable, user: RequestUser) {
    const authorize = () => this.access.administer(user, libraryId);
    await authorize();
    const [source] = await this.db
      .select()
      .from(schema.fanfictionSources)
      .where(and(eq(schema.fanfictionSources.id, sourceId), eq(schema.fanfictionSources.libraryId, libraryId)))
      .limit(1);
    if (!source?.bookFileId || source.state === 'unlinked') throw new NotFoundException('An existing managed EPUB is required');
    await this.catalog.requireFile(source.bookFileId, libraryId);
    const uploaded = await this.uploads.stage(stream, filename, libraryId, user.id, authorize);
    let claimed = false;
    try {
      const committed = await this.db.transaction(async (tx) => {
        await authorize();
        const result = await this.jobs.updateStory(source, 'replacement', dto.idempotencyKey, user, false, undefined, tx, {
          uploadId: uploaded.id,
          sha256: uploaded.sha256,
          expectedRevisionId: dto.expectedRevisionId,
        });
        const [saved] = await tx
          .select({ uploadId: schema.fanfictionJobs.replacementUploadId })
          .from(schema.fanfictionJobs)
          .where(eq(schema.fanfictionJobs.id, result.id))
          .limit(1);
        if (saved.uploadId === uploaded.id) {
          await this.uploads.claim(tx, uploaded.id, libraryId, user.id, result.id);
        }
        return { result, claimed: saved.uploadId === uploaded.id };
      });
      claimed = committed.claimed;
      return committed.result;
    } finally {
      if (!claimed) await this.uploads.discard(uploaded.id, user.id);
    }
  }

  async run(job: Job, authorize: () => Promise<unknown>, signal: AbortSignal): Promise<FanfictionJob['result']> {
    const result = await this.execute(job, authorize, signal);
    if (result?.revisionId && job.replacementUploadId) await this.uploads.releaseOwned(job.replacementUploadId, job.id, job.libraryId);
    return result;
  }

  private async execute(job: Job, authorize: () => Promise<unknown>, signal: AbortSignal): Promise<FanfictionJob['result']> {
    if (job.kind !== 'replacement' || !job.replacementUploadId || !job.replacementSha256 || !job.expectedRevisionId)
      throw new BadRequestException('The replacement upload is incomplete');
    const check = async () => {
      if (signal.aborted) throw new ConflictException('Replacement was cancelled');
      await authorize();
    };
    if (job.result?.revisionId) return job.result;
    const source = await this.sources.updateContext(job);
    const fileId = source.bookFileId!;
    const authority: RevisionPublicationAuthority = {
      ownerKey: job.id,
      authorize: async (tx) => {
        await check();
        await this.sources.assertUpdatable(job, tx);
      },
    };
    const finish = async (revisionId: string, noChange: boolean, replacement: FanfictionReplacementReview) => {
      await check();
      return this.sources.completeUpdate(job, { sourceId: source.id, bookId: source.bookId!, bookFileId: fileId, revisionId, noChange, replacement });
    };
    const owned = await this.publications.ownedPublication(fileId, job.libraryId, authority);
    if (owned) {
      if (!job.result?.replacement?.identityMatches) throw new ConflictException('Replacement publication has no verified source evidence');
      const installed = await this.publications.resume(owned.id, job.libraryId, authority);
      return finish(installed.revisionId, false, job.result.replacement);
    }
    return this.uploads.withFile(job.replacementUploadId, job.id, job.libraryId, check, async (path) => {
      await this.revisions.observeFile(fileId, {});
      const current = await this.catalog.current(fileId, job.libraryId);
      if (current.id !== job.expectedRevisionId)
        throw new ConflictException({
          message: 'The installed EPUB changed; upload again against the current revision',
          errorCode: 'replacement_revision_changed',
        });
      const evidence = await this.manifests.sourceEvidence(path);
      const recognized = evidence.sourceUrls.length
        ? await this.runtime.recognize(
            evidence.sourceUrls.map((url) => url.replace(/^http:\/\//i, 'https://')),
            signal,
          )
        : [];
      const identities = new Set(recognized.filter((url) => url.recognized).map((url) => this.sources.canonicalUrl(url.canonicalUrl)));
      const replacement: FanfictionReplacementReview = {
        sha256: job.replacementSha256!,
        expectedRevisionId: current.id,
        title: evidence.title || source.title,
        authors: evidence.authors.length ? evidence.authors : source.authors,
        previousChapterCount: source.chapterCount,
        chapterCount: evidence.chapterCount,
        identityMatches: identities.size === 1 && identities.has(source.canonicalUrl),
      };
      await this.jobs.recordReplacementReview(job, replacement);
      if (!replacement.identityMatches)
        throw new BadRequestException({ message: 'The EPUB source identity does not match this story', errorCode: 'replacement_identity_mismatch' });
      if (replacement.chapterCount < source.chapterCount && !job.replacementReductionApproved)
        throw new BadRequestException({
          message: 'The replacement contains fewer chapters and needs approval',
          errorCode: 'replacement_chapter_reduction',
        });
      const next = await this.manifests.inspect(path);
      if (current.contentHash === next.contentHash && current.metadataHash === next.metadataHash && current.coverHash === next.coverHash) {
        await this.revisions.observeFile(fileId, {});
        if ((await this.catalog.current(fileId, job.libraryId)).id !== current.id)
          throw new ConflictException('The installed EPUB changed during comparison');
        return finish(current.id, true, replacement);
      }
      const prepared = await this.publications.prepare(fileId, job.libraryId, current.id, path, 'replacement', authority, job.replacementSha256!);
      const installed = await this.publications.resume(prepared.publicationId, job.libraryId, authority);
      return finish(installed.revisionId, false, replacement);
    });
  }
}
