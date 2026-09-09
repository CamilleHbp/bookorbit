import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { storageConfig } from '../../config/config';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { RevisionFileService } from '../book-revision/revision-file.service';
import { EpubManifestService } from '../book-revision/epub-manifest.service';

const uploads = schema.bookDockManagedUploads;
export const MANAGED_UPLOAD_MAX_BYTES = 128 * 1024 * 1024;

@Injectable()
export class BookDockManagedUploadService {
  private readonly logger = new Logger(BookDockManagedUploadService.name);
  private cleaning = false;

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
    private readonly files: RevisionFileService,
    private readonly manifests: EpubManifestService,
  ) {}

  private paths(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw new BadRequestException('Invalid managed upload identity');
    const directory = join(this.storage.bookDockPath, `managed-upload-${id}`);
    return { directory, path: join(directory, 'story.epub') };
  }

  async stage(stream: Readable, filename: string, libraryId: number, userId: number, authorize: () => Promise<unknown>) {
    if (!filename.toLowerCase().endsWith('.epub')) throw new BadRequestException('Choose an EPUB replacement');
    const id = randomUUID();
    const { directory, path } = this.paths(id);
    const startedAt = Date.now();
    await authorize();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('book_dock.managed_upload_budget', 0))`);
      const [usage] = await tx
        .select({
          bytes: sql<number>`coalesce(sum(case when ${uploads.state} = 'uploading' then ${MANAGED_UPLOAD_MAX_BYTES} else ${uploads.sizeBytes} end), 0)::bigint`,
          count: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${uploads.state} = 'uploading')::int`,
        })
        .from(uploads);
      if (Number(usage.bytes) + MANAGED_UPLOAD_MAX_BYTES > 1024 * 1024 * 1024 || usage.count >= 128 || usage.active >= 2)
        throw new ServiceUnavailableException('Managed upload storage is busy; retry after pending replacements finish');
      const [dock] = await tx
        .insert(schema.bookDockFiles)
        .values({
          fileName: 'story.epub',
          absolutePath: path,
          unitDirectory: directory,
          fileSize: 0,
          format: 'epub',
          uploadedBy: userId,
          targetLibraryId: libraryId,
          ingestionMode: 'managed',
          autoFinalizeSuppressed: true,
        })
        .returning({ id: schema.bookDockFiles.id });
      await tx.insert(uploads).values({ id, dockFileId: dock.id, libraryId, userId, expiresAt: sql`now() + interval '5 minutes'` });
    });
    this.logger.log(`[book_dock.managed_upload] [start] uploadId=${id} libraryId=${libraryId} userId=${userId} - managed EPUB upload started`);
    try {
      await mkdir(this.storage.bookDockPath, { recursive: true });
      await mkdir(directory, { mode: 0o700 });
      await this.files.sync(this.storage.bookDockPath);
      let sizeBytes = 0;
      const hash = createHash('sha256');
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          if (sizeBytes > MANAGED_UPLOAD_MAX_BYTES) return callback(new BadRequestException('EPUB exceeds the 128 MiB replacement limit'));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(stream, bounded, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(120_000) });
      if (!sizeBytes || (stream as Readable & { truncated?: boolean }).truncated) throw new BadRequestException('The EPUB upload is incomplete');
      const handle = await open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.files.sync(directory);
      const sha256 = hash.digest('hex');
      await this.manifests.inspect(path);
      await this.files.require(path, sha256);
      await authorize();
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(uploads)
          .set({ state: 'ready', sha256, sizeBytes, expiresAt: sql`now() + interval '24 hours'` })
          .where(and(eq(uploads.id, id), eq(uploads.state, 'uploading')))
          .returning();
        if (!row) throw new ConflictException('The managed upload expired');
        await tx.update(schema.bookDockFiles).set({ status: 'ready', fileSize: sizeBytes }).where(eq(schema.bookDockFiles.id, row.dockFileId!));
      });
      this.logger.log(
        `[book_dock.managed_upload] [end] uploadId=${id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} sizeBytes=${sizeBytes} - managed EPUB upload saved`,
      );
      return { id, sha256, sizeBytes };
    } catch (error) {
      await this.discard(id, userId).catch(() => undefined);
      this.logger.warn(
        `[book_dock.managed_upload] [fail] uploadId=${id} libraryId=${libraryId} durationMs=${Date.now() - startedAt} errorClass=UploadError error="managed EPUB upload failed" - reserved upload will be cleaned up`,
      );
      throw error;
    }
  }

  async claim(tx: DatabaseTransaction, id: string, libraryId: number, userId: number, ownerKey: string) {
    const [row] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, id), eq(uploads.libraryId, libraryId), eq(uploads.userId, userId)))
      .for('update');
    if (!row?.sha256 || row.state === 'uploading' || row.expiresAt <= new Date() || (row.ownerKey && row.ownerKey !== ownerKey))
      throw new ConflictException('The replacement upload is unavailable or already owned');
    await tx
      .update(uploads)
      .set({ state: 'claimed', ownerKey, expiresAt: sql`now() + interval '7 days'` })
      .where(eq(uploads.id, id));
    return { sha256: row.sha256, sizeBytes: row.sizeBytes };
  }

  async withFile<T>(id: string, ownerKey: string, libraryId: number, authorize: () => Promise<unknown>, operation: (path: string) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(uploads)
        .where(and(eq(uploads.id, id), eq(uploads.ownerKey, ownerKey), eq(uploads.libraryId, libraryId)))
        .for('update');
      if (!row?.sha256 || row.state !== 'claimed' || row.expiresAt <= new Date())
        throw new NotFoundException({ message: 'The replacement upload expired; upload the EPUB again', errorCode: 'replacement_upload_missing' });
      await authorize();
      const { directory, path } = this.paths(id);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConflictException('Managed upload directory changed');
      await this.files.require(path, row.sha256);
      await tx
        .update(uploads)
        .set({ expiresAt: sql`now() + interval '7 days'` })
        .where(eq(uploads.id, id));
      return operation(path);
    });
  }

  async discard(id: string, userId: number, ownerKey?: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(uploads)
        .where(and(eq(uploads.id, id), eq(uploads.userId, userId)))
        .for('update');
      if (!row) return;
      if (row.ownerKey !== (ownerKey ?? null)) throw new ConflictException('The managed upload belongs to an active operation');
      await this.remove(tx, row);
    });
  }

  async releaseOwned(id: string, ownerKey: string, libraryId: number) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(uploads)
        .where(and(eq(uploads.id, id), eq(uploads.ownerKey, ownerKey), eq(uploads.libraryId, libraryId)))
        .for('update');
      if (row) await this.remove(tx, row);
    });
  }

  private async remove(tx: DatabaseTransaction, row: typeof uploads.$inferSelect) {
    const { directory, path } = this.paths(row.id);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConflictException('Managed upload directory changed');
      await rm(path, { force: true });
      await rmdir(directory);
      await this.files.sync(this.storage.bookDockPath);
    }
    await tx.delete(uploads).where(eq(uploads.id, row.id));
    if (row.dockFileId) await tx.delete(schema.bookDockFiles).where(eq(schema.bookDockFiles.id, row.dockFileId));
  }

  @Interval(60_000)
  async cleanupExpired() {
    if (this.cleaning) return;
    this.cleaning = true;
    const startedAt = Date.now();
    let removed = 0;
    let failed = 0;
    let started = false;
    try {
      for (let index = 0; index < 20; index++) {
        let selectedId: string | undefined;
        try {
          const found = await this.db.transaction(async (tx) => {
            const [row] = await tx
              .select()
              .from(uploads)
              .where(lt(uploads.expiresAt, sql`now()`))
              .orderBy(asc(uploads.expiresAt), asc(uploads.id))
              .limit(1)
              .for('update', { skipLocked: true });
            if (!row) return false;
            selectedId = row.id;
            if (!started) {
              started = true;
              this.logger.log('[book_dock.managed_upload_cleanup] [start] limit=20 - expired managed upload cleanup started');
            }
            await this.remove(tx, row);
            return true;
          });
          if (!found) break;
          removed++;
        } catch {
          if (!selectedId) throw new ConflictException('Managed upload cleanup could not acquire an expired upload');
          failed++;
          await this.db
            .update(uploads)
            .set({ expiresAt: sql`now() + interval '1 hour'` })
            .where(and(eq(uploads.id, selectedId), lt(uploads.expiresAt, sql`now()`)));
          this.logger.warn(
            `[book_dock.managed_upload_cleanup] [fail] uploadId=${selectedId} durationMs=${Date.now() - startedAt} errorClass=CleanupError error="managed upload cleanup failed" - upload cleanup deferred`,
          );
        }
      }
      if (started)
        this.logger.log(
          `[book_dock.managed_upload_cleanup] [end] durationMs=${Date.now() - startedAt} removed=${removed} failed=${failed} - expired managed upload cleanup completed`,
        );
    } catch {
      this.logger.warn(
        `[book_dock.managed_upload_cleanup] [fail] durationMs=${Date.now() - startedAt} errorClass=CleanupError error="managed upload cleanup failed" - cleanup will retry`,
      );
    } finally {
      this.cleaning = false;
    }
  }
}
