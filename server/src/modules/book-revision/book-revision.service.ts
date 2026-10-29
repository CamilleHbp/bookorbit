import { RevisionCoordinationService } from './revision-coordination.service';
import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { stat } from 'node:fs/promises';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { inspectStableFile, sameFileSignature, waitForStableFile } from './file-inspection';
import { EpubManifestService } from './epub-manifest.service';

@Injectable()
export class BookRevisionService {
  private readonly logger = new Logger(BookRevisionService.name);
  private activeInspections = 0;

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly manifests: EpubManifestService,
    private readonly coordination: RevisionCoordinationService,
  ) {}

  async observeFile(id: number, changes: Partial<typeof schema.bookFiles.$inferInsert>) {
    const event = 'book.revision_inspect';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] bookFileId=${id} - file inspection started`);
    let admitted = false;
    try {
      if (this.activeInspections >= 2) throw new ServiceUnavailableException('File inspection is busy; retry later');
      this.activeInspections++;
      admitted = true;
      const [expected] = await this.db.select().from(schema.bookFiles).where(eq(schema.bookFiles.id, id)).limit(1);
      if (!expected) throw new NotFoundException('Book file no longer exists');
      const path = changes.absolutePath ?? expected.absolutePath;
      if ((await waitForStableFile(path)) !== 'stable')
        throw new ServiceUnavailableException('File is unavailable or still changing; retry inspection');
      const inspected = await inspectStableFile(path);
      if (inspected.status !== 'stable') throw new ServiceUnavailableException('File changed or could not be read; retry inspection');
      const fresh = inspected.file;
      const format = changes.format ?? expected.format;
      const manifest =
        (format === 'epub' || format === 'kepub') && (!expected.currentRevisionId || fresh.sha256 !== expected.sha256)
          ? await this.manifests.inspect(path)
          : null;
      const result = await this.db.transaction(async (tx) => {
        await this.coordination.lockFile(tx, id);
        const [current] = await tx
          .select()
          .from(schema.bookFiles)
          .where(and(eq(schema.bookFiles.id, id), eq(schema.bookFiles.libraryFolderId, expected.libraryFolderId)))
          .for('update');
        if (
          !current ||
          current.absolutePath !== expected.absolutePath ||
          current.bookId !== expected.bookId ||
          current.updatedAt.getTime() !== expected.updatedAt.getTime() ||
          current.currentRevisionId !== expected.currentRevisionId
        ) {
          throw new ConflictException('Book file changed while inspecting; retry inspection');
        }
        const [publication] = await tx
          .select({ id: schema.revisionPublications.id })
          .from(schema.revisionPublications)
          .where(
            and(eq(schema.revisionPublications.bookFileId, id), inArray(schema.revisionPublications.state, ['prepared', 'filesystem_published'])),
          )
          .limit(1);
        if (publication) throw new ConflictException('A managed replacement must finish recovery before scanning this file');
        const atPath = await stat(path, { bigint: true });
        if (!sameFileSignature(fresh.signature, atPath)) throw new ConflictException('File changed before inspection could be saved');
        const changed = current.sha256 !== fresh.sha256 || !current.currentRevisionId;
        let revisionId = current.currentRevisionId;
        if (changed) {
          const [previous] = current.currentRevisionId
            ? await tx
                .select()
                .from(schema.bookFileRevisions)
                .where(and(eq(schema.bookFileRevisions.id, current.currentRevisionId), eq(schema.bookFileRevisions.bookFileId, id)))
                .limit(1)
            : [];
          const changeKind = !current.currentRevisionId
            ? 'baseline'
            : !manifest || !previous?.contentHash
              ? 'unknown'
              : manifest.contentHash !== previous.contentHash
                ? 'content'
                : manifest.coverHash !== previous.coverHash
                  ? 'cover'
                  : manifest.metadataHash !== previous.metadataHash
                    ? 'metadata'
                    : 'container';
          const [revision] = await tx
            .insert(schema.bookFileRevisions)
            .values({
              bookFileId: id,
              sha256: fresh.sha256,
              fileHash: fresh.fileHash,
              sizeBytes: fresh.sizeBytes,
              reason: current.currentRevisionId ? 'external_change' : 'baseline',
              changeKind,
              ...(manifest && {
                chapters: manifest.chapters,
                manifestVersion: manifest.version,
                contentHash: manifest.contentHash,
                metadataHash: manifest.metadataHash,
                coverHash: manifest.coverHash,
              }),
            })
            .returning({ id: schema.bookFileRevisions.id });
          revisionId = revision.id;
        }
        if (current.fileHash && current.fileHash !== fresh.fileHash) {
          await tx
            .insert(schema.bookFileHashHistory)
            .values({ bookFileId: id, fileHash: current.fileHash, reason: 'external_change' })
            .onConflictDoNothing();
        }
        const [file] = await tx
          .update(schema.bookFiles)
          .set({
            ...changes,
            ino: fresh.ino,
            sizeBytes: fresh.sizeBytes,
            mtime: fresh.mtime,
            fileHash: fresh.fileHash,
            sha256: fresh.sha256,
            currentRevisionId: revisionId,
            updatedAt: new Date(),
          })
          .where(eq(schema.bookFiles.id, id))
          .returning();
        return { file, changed };
      });
      this.logger.log(
        `[${event}] [end] bookFileId=${id} durationMs=${Date.now() - startedAt} revisionCreated=${result.changed} - file inspection completed`,
      );
      return result.file;
    } catch (error) {
      this.logger.warn(
        `[${event}] [fail] bookFileId=${id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Inspection failed')}" - file inspection failed`,
      );
      throw error;
    } finally {
      if (admitted) this.activeInspections--;
    }
  }
}
