import { BadRequestException, Injectable } from '@nestjs/common';
import type { FanfictionProfileDocument, FanfictionJob } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import type * as schema from '../../db/schema';
import { BookDockManagedService, type AuthorizeManagedImport } from '../book-dock/book-dock-managed.service';
import { BookRevisionService } from '../book-revision/book-revision.service';
import { RevisionCatalogService } from '../book-revision/revision-catalog.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionSourceService } from './fanfiction-source.service';
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
  ): Promise<FanfictionJob['result']> {
    const resumed = await this.sources.resume(job, user);
    const { source, owned } = resumed ?? (await this.sources.reserve(job, await this.runtime.preview(job.url, document, signal, saveCookies), user));
    if (!owned)
      return { sourceId: source.id, ...(source.bookId && source.bookFileId ? { bookId: source.bookId, bookFileId: source.bookFileId } : {}) };
    const input = {
      operationId: source.importOperationId,
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
      const installed = await this.dock.ingest({ ...input, sourcePath: path }, authorizeImport);
      await authorize();
      await this.catalog.requireFile(installed.bookFileId, source.libraryId);
      await this.revisions.observeFile(installed.bookFileId, {});
      await authorize();
      await this.sources.completeImport(job, source.id, installed);
      return { sourceId: source.id, bookId: installed.bookId, bookFileId: installed.bookFileId };
    };
    if (await this.dock.isPrepared(input, authorizeImport)) return install('');
    const effective =
      source.profileId === job.profileId
        ? { document, saveCookies }
        : source.profileId
          ? await this.profiles.session(job.libraryId, source.profileId, user, authorize)
          : { document: { configuration: '', cookies: [] }, saveCookies: undefined };
    return this.runtime.download(
      source.canonicalUrl,
      effective.document,
      async (path, downloaded) => {
        if (this.sources.canonicalUrl(downloaded.canonicalUrl) !== source.canonicalUrl || downloaded.chapterCount < source.chapterCount) {
          throw new BadRequestException({ message: 'The story identity or chapter count changed before import', errorCode: 'review_required' });
        }
        return install(path);
      },
      signal,
      effective.saveCookies,
    );
  }
}
