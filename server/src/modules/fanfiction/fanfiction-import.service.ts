import { BadRequestException, Injectable } from '@nestjs/common';
import type { FanfictionProfileDocument, FanfictionJob, FanfictionImportProgress } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import type * as schema from '../../db/schema';
import { BookDockManagedService, type AuthorizeManagedImport } from '../book-dock/book-dock-managed.service';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionSourceService } from './fanfiction-source.service';
import { withFanfictionDefaults } from './fanfiction-defaults';
import { FanfictionProfileService } from './fanfiction-profile.service';

import type { FanfictionCookieSink } from './fanfiction-cookies';

type Job = typeof schema.fanfictionJobs.$inferSelect;

@Injectable()
export class FanfictionImportService {
  constructor(
    private readonly runtime: FanficfareRuntimeService,
    private readonly sources: FanfictionSourceService,
    private readonly profiles: FanfictionProfileService,
    private readonly dock: BookDockManagedService,
    private readonly revisions: BookRevisionService,
    private readonly catalog: RevisionCatalogService,
  ) {}

  async run(
    job: Job,
    user: RequestUser,
    document: FanfictionProfileDocument,
    authorize: () => Promise<unknown>,
    signal: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reportProgress: (progress: FanfictionImportProgress) => Promise<void> = async () => {},
  ): Promise<FanfictionJob['result']> {
    await reportProgress({ stage: 'metadata' });
    const resumed = await this.sources.resume(job, user);
    const preview = job.result?.importReview?.preview ?? (resumed ? null : await this.runtime.preview(job.url, document, signal, saveCookies));
    const { source, owned } = resumed ?? (await this.sources.reserve(job, preview!, user));
    if (!owned && source.bookId && source.bookFileId && job.sourceId === source.id && job.result?.importReview?.approved)
      return { sourceId: source.id, bookId: source.bookId, bookFileId: source.bookFileId, preview: job.result.importReview.preview };
    if (!owned)
      return {
        sourceId: source.id,
        ...(!source.bookFileId ? { existingImportId: await this.sources.pendingImport(job.libraryId, source.id) } : {}),
        ...(source.bookId && source.bookFileId
          ? {
              bookId: source.bookId,
              bookFileId: source.bookFileId,
              existingStory: { id: source.id, title: source.title, bookId: source.bookId, attentionCode: source.attentionCode },
            }
          : {}),
      };
    if (!job.result?.importReview?.approved) {
      const incoming = preview ?? (await this.runtime.preview(source.canonicalUrl, document, signal, saveCookies));
      return {
        sourceId: source.id,
        preview: incoming,
        importReview: {
          preview: incoming,
          values: { title: incoming.title, description: incoming.description, authors: incoming.authors, tags: incoming.tags },
          approved: false,
        },
      };
    }
    const input = {
      operationId: source.importOperationId,
      finalMetadata: job.result.importReview.values,
      metadataSourceKey: `fanfiction:${source.id}`,
      libraryId: source.libraryId,
      folderId: source.folderId!,
      userId: source.createdBy,
      sourcePath: '',
      relativePath: source.relativePath,
    };
    const authorizeImport: AuthorizeManagedImport = async (tx) => {
      if (signal.aborted) throw new BadRequestException('Story import was cancelled');
      await authorize();
      await this.sources.assertImportable(job, source.id, tx);
    };
    const install = async (path: string) => {
      await reportProgress({ stage: 'importing', completedChapters: source.chapterCount, totalChapters: source.chapterCount });
      const installed = await this.dock.ingest({ ...input, sourcePath: path }, authorizeImport);
      await reportProgress({ stage: 'finalizing', completedChapters: source.chapterCount, totalChapters: source.chapterCount });
      await authorize();
      await this.catalog.requireFile(installed.bookFileId, source.libraryId);
      await this.revisions.observeFile(installed.bookFileId, {});
      await authorize();
      await this.sources.completeImport(job, source.id, installed);
      return { sourceId: source.id, bookId: installed.bookId, bookFileId: installed.bookFileId, preview: job.result!.importReview!.preview };
    };
    if (await this.dock.isPrepared(input, authorizeImport)) return install('');
    const effective =
      source.profileId === job.profileId
        ? { document, saveCookies }
        : source.profileId
          ? await this.profiles.session(job.libraryId, source.profileId, user, authorize)
          : { document: withFanfictionDefaults({ configuration: '', cookies: [] }, user), saveCookies: undefined };
    return this.runtime.download(
      source.canonicalUrl,
      effective.document,
      async (path, downloaded) => {
        await authorize();
        await this.sources.recordImportMetadata(job, source.id, downloaded, user);
        return install(path);
      },
      signal,
      effective.saveCookies,
      reportProgress,
    );
  }
}
