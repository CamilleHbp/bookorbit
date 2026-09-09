import { FanfictionReviewService } from './fanfiction-review.service';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FanfictionJob, FanfictionPreview, FanfictionProfileDocument } from '@bookorbit/types';
import type * as schema from '../../db/schema';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { EpubManifestService } from '../book-revision/epub-manifest.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { RevisionDownloadService } from '../book-revision/revision-download.service';
import { RevisionPublicationService } from '../book-revision/revision-publication.service';
import type { RevisionPublicationAuthority } from '../book-revision/revision-publication-authority';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { MetadataService } from '../metadata/metadata.service';

import type { FanfictionCookieSink } from './fanfiction-cookies';

type Job = typeof schema.fanfictionJobs.$inferSelect;

@Injectable()
export class FanfictionUpdateService {
  constructor(
    private readonly reviews: FanfictionReviewService,
    private readonly runtime: FanficfareRuntimeService,
    private readonly sources: FanfictionSourceService,
    private readonly revisions: BookRevisionService,
    private readonly catalog: RevisionCatalogService,
    private readonly downloads: RevisionDownloadService,
    private readonly publications: RevisionPublicationService,
    private readonly manifests: EpubManifestService,
    private readonly metadata: MetadataService,
  ) {}

  async run(
    job: Job,
    document: FanfictionProfileDocument,
    authorize: () => Promise<unknown>,
    signal: AbortSignal,
    saveCookies?: FanfictionCookieSink,
  ): Promise<FanfictionJob['result']> {
    if (job.result?.revisionId) return job.result;
    const source = await this.sources.updateContext(job);
    const fileId = source.bookFileId!;
    const access = async () => {
      if (signal.aborted) throw new ConflictException('Story update was cancelled');
      await authorize();
    };
    const authority: RevisionPublicationAuthority = {
      ownerKey: job.id,
      authorize: async (tx) => {
        await access();
        await this.sources.assertUpdatable(job, tx);
      },
    };
    const finish = async (revisionId: string, noChange: boolean, preview?: FanfictionPreview) => {
      await access();
      const file = await this.catalog.fileLocation(fileId, source.libraryId);
      if (file.bookId !== source.bookId) throw new ConflictException('The managed book identity changed');
      await this.metadata.refreshCoverForBook(file.bookId, file.absolutePath, 'epub');
      await access();
      return this.sources.completeUpdate(job, { sourceId: source.id, bookId: source.bookId!, bookFileId: fileId, revisionId, noChange }, preview);
    };
    const owned = await this.publications.ownedPublication(fileId, source.libraryId, authority);
    if (job.result?.preparedUpdate && job.result.preview && !job.result.revisionId && (job.result.preparedUpdate.noChange || owned)) {
      job.result = await this.reviews.prepare(job, job.result.preview, job.result.preparedUpdate.noChange, true);
      if (job.result.metadataReview && !job.result.preparedUpdate?.approved) return job.result;
      if (job.result.preparedUpdate!.noChange) return finish(job.expectedRevisionId!, true, job.result.preview);
    }
    const approvedAuthority = {
      ...authority,
      commit: async (tx: Parameters<typeof authority.authorize>[0]) => {
        await this.reviews.apply(tx, job, source.bookId!);
      },
      authorize: async (tx: Parameters<typeof authority.authorize>[0]) => {
        await authority.authorize(tx);
        await this.reviews.assertApproved(job, tx);
      },
    };
    if (owned) {
      const installed = await this.publications.resume(owned.id, source.libraryId, approvedAuthority);
      return finish(installed.revisionId, false, job.result?.preview);
    }
    await access();
    await this.catalog.requireFile(fileId, source.libraryId);
    await this.revisions.observeFile(fileId, {});
    const current = await this.catalog.current(fileId, source.libraryId);
    const expected = await this.sources.expectRevision(job, current.id);
    if (expected !== current.id)
      throw new ConflictException({ message: 'Installed EPUB changed before the update could resume', errorCode: 'review_required' });
    if (job.kind !== 'update' && job.kind !== 'refresh') throw new BadRequestException('Invalid source update operation');
    return this.runtime.update(
      job.kind,
      source.canonicalUrl,
      document,
      async (path) => {
        const snapshot = await this.downloads.download(fileId, source.libraryId, expected, access);
        await pipeline(snapshot.stream, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
      },
      async (path, preview) => {
        await access();
        if (this.sources.canonicalUrl(preview.canonicalUrl) !== source.canonicalUrl || preview.chapterCount < source.chapterCount)
          throw new BadRequestException({ message: 'Story identity or chapter count requires review', errorCode: 'review_required' });
        const next = await this.manifests.inspect(path);
        if (current.contentHash === next.contentHash && current.metadataHash === next.metadataHash && current.coverHash === next.coverHash) {
          await this.revisions.observeFile(fileId, {});
          if ((await this.catalog.current(fileId, source.libraryId)).id !== expected)
            throw new ConflictException('Installed EPUB changed during update');
          job.result = await this.reviews.prepare(job, preview, true);
          if (job.result.metadataReview && !job.result.preparedUpdate?.approved) return job.result;
          return finish(expected, true, preview);
        }
        job.result = await this.reviews.prepare(job, preview, false);
        const prepared = await this.publications.prepare(fileId, source.libraryId, expected, path, 'fanficfare', authority);
        if (job.result.metadataReview && !job.result.preparedUpdate?.approved) return job.result;
        const installed = await this.publications.resume(prepared.publicationId, source.libraryId, approvedAuthority);
        return finish(installed.revisionId, false, preview);
      },
      signal,
      saveCookies,
    );
  }
}
