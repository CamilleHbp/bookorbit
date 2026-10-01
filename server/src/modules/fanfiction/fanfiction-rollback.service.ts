import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { FanfictionJob } from '@bookorbit/types';
import type * as schema from '../../db/schema';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { RevisionPublicationService } from '../book-revision/revision-publication.service';
import type { RevisionPublicationAuthority } from '../book-revision/revision-publication-authority';
import { FanfictionSourceService } from './fanfiction-source.service';

@Injectable()
export class FanfictionRollbackService {
  constructor(
    private readonly sources: FanfictionSourceService,
    private readonly revisions: BookRevisionService,
    private readonly catalog: RevisionCatalogService,
    private readonly publications: RevisionPublicationService,
  ) {}

  async run(
    job: typeof schema.fanfictionJobs.$inferSelect,
    authorize: () => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<FanfictionJob['result']> {
    if (job.result?.revisionId) return job.result;
    if (job.kind !== 'rollback' || !job.rollbackRevisionId || !job.expectedRevisionId)
      throw new BadRequestException('Rollback requires an expected revision and retained EPUB');
    const source = await this.sources.updateContext(job);
    const fileId = source.bookFileId!;
    const access = async () => {
      if (signal.aborted) throw new ConflictException('Rollback was cancelled');
      await authorize();
    };
    const authority: RevisionPublicationAuthority = {
      ownerKey: job.id,
      authorize: async (tx) => {
        await access();
        await this.sources.assertUpdatable(job, tx);
      },
    };
    let publicationId = (await this.publications.ownedPublication(fileId, job.libraryId, authority))?.id;
    if (!publicationId) {
      await access();
      await this.catalog.requireFile(fileId, job.libraryId);
      await this.revisions.observeFile(fileId, {});
      const retained = await this.catalog.retained(fileId, job.libraryId, job.rollbackRevisionId, job.expectedRevisionId);
      publicationId = (
        await this.publications.prepare(fileId, job.libraryId, job.expectedRevisionId, retained.path, 'rollback', authority, retained.sha256)
      ).publicationId;
    }
    const installed = await this.publications.resume(publicationId, job.libraryId, authority);
    await access();
    return this.sources.completeRollback(job, installed.revisionId);
  }
}
