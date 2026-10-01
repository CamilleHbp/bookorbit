import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { storageConfig } from '../../config/config';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { snapshotRevisionFile, streamRevisionSnapshot } from './revision-snapshot';

@Injectable()
export class RevisionDownloadService {
  private readonly logger = new Logger(RevisionDownloadService.name);
  private active = 0;

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async download(fileId: number, libraryId: number, revisionId: string, checkAccess: () => Promise<void>) {
    if (this.active >= 2) throw new ServiceUnavailableException('Revision download capacity is currently in use');
    this.active++;
    const startedAt = Date.now();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
    this.logger.log(`[revision.download] [start] fileId=${fileId} libraryId=${libraryId} revisionId=${revisionId} - revision snapshot started`);
    try {
      await checkAccess();
      const file = await this.requireCurrentRevision(fileId, libraryId, revisionId);
      const snapshot = await snapshotRevisionFile(
        file.path,
        join(this.storage.appDataPath, 'revision-downloads'),
        file.sha256,
        file.sizeBytes,
        checkAccess,
      );
      try {
        await this.requireCurrentRevision(fileId, libraryId, revisionId);
        await checkAccess();
      } catch (error) {
        await snapshot.close();
        throw error;
      }
      const stream = streamRevisionSnapshot(snapshot, file.sizeBytes, checkAccess, release);
      stream.once('error', (error) =>
        this.logger.warn(
          `[revision.download] [fail] fileId=${fileId} libraryId=${libraryId} revisionId=${revisionId} durationMs=${Date.now() - startedAt} errorClass=${error.name} error="${sanitizeLogValue(error.message)}" - revision download failed`,
        ),
      );
      stream.once('end', () =>
        this.logger.log(
          `[revision.download] [end] fileId=${fileId} libraryId=${libraryId} revisionId=${revisionId} durationMs=${Date.now() - startedAt} sizeBytes=${file.sizeBytes} - revision download completed`,
        ),
      );
      return { stream, sizeBytes: file.sizeBytes, sha256: file.sha256, revisionId };
    } catch (error) {
      release();
      this.logger.warn(
        `[revision.download] [fail] fileId=${fileId} libraryId=${libraryId} revisionId=${revisionId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - revision snapshot failed`,
      );
      throw error;
    }
  }

  private async requireCurrentRevision(fileId: number, libraryId: number, revisionId: string) {
    const [file] = await this.db
      .select({
        path: schema.bookFiles.absolutePath,
        format: schema.bookFiles.format,
        currentRevisionId: schema.bookFiles.currentRevisionId,
        sha256: schema.bookFileRevisions.sha256,
        sizeBytes: schema.bookFileRevisions.sizeBytes,
      })
      .from(schema.bookFiles)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookFiles.bookId))
      .innerJoin(
        schema.bookFileRevisions,
        and(eq(schema.bookFileRevisions.bookFileId, schema.bookFiles.id), eq(schema.bookFileRevisions.id, revisionId)),
      )
      .where(and(eq(schema.bookFiles.id, fileId), eq(schema.books.libraryId, libraryId)))
      .limit(1);
    if (!file) throw new NotFoundException('Revision not found in this library');
    if (!['epub', 'kepub'].includes(file.format)) throw new ConflictException('Revision download requires an EPUB file');
    if (file.currentRevisionId !== revisionId) throw new ConflictException('The expected revision is no longer current');
    return file;
  }
}
