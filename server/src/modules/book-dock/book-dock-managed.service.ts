import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { link, lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { storageConfig } from '../../config/config';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { DatabaseTransaction } from '../../db/transaction';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { EpubManifestService } from '../book-revision/epub-manifest.service';
import { RevisionFileService } from '../book-revision/revision-file.service';
import { LibraryService } from '../library/library.service';
import { MetadataService } from '../metadata/metadata.service';
import { UploadProcessorService } from '../upload/upload-processor.service';
import { UploadValidatorService } from '../upload/upload-validator.service';

export interface ManagedDockImport {
  operationId: string;
  libraryId: number;
  folderId: number;
  userId: number;
  sourcePath: string;
  relativePath: string;
}

export type AuthorizeManagedImport = (transaction: DatabaseTransaction) => Promise<void>;
type ImportRow = typeof schema.bookDockManagedImports.$inferSelect;

@Injectable()
export class BookDockManagedService {
  private readonly logger = new Logger(BookDockManagedService.name);

  constructor(
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
    private readonly libraries: LibraryService,
    private readonly files: RevisionFileService,
    private readonly manifests: EpubManifestService,
    private readonly processor: UploadProcessorService,
    private readonly metadata: MetadataService,
    private readonly validator: UploadValidatorService,
  ) {}

  async ingest(input: ManagedDockImport, authorize: AuthorizeManagedImport) {
    const startedAt = Date.now();
    this.logger.log(
      `[book_dock.managed_import] [start] operationId=${input.operationId} libraryId=${input.libraryId} userId=${input.userId} - managed import started`,
    );
    try {
      await this.reserve(input, authorize);
      let result: ImportRow | undefined;
      for (let transition = 0; transition < 7; transition++) {
        result = await this.advance(input, authorize);
        if (result.state === 'cleanup_complete') break;
      }
      if (!result?.bookId || !result.bookFileId || result.state !== 'cleanup_complete') {
        throw new ConflictException('Managed import did not finish recovery');
      }
      this.logger.log(
        `[book_dock.managed_import] [end] operationId=${input.operationId} libraryId=${input.libraryId} durationMs=${Date.now() - startedAt} bookId=${result.bookId} - managed import completed`,
      );
      return { bookId: result.bookId, bookFileId: result.bookFileId, dockFileId: result.dockFileId };
    } catch (error) {
      this.logger.warn(
        `[book_dock.managed_import] [fail] operationId=${input.operationId} libraryId=${input.libraryId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Import failed')}" - managed import remains recoverable`,
      );
      throw error;
    }
  }

  private scope(input: ManagedDockImport) {
    return and(
      eq(schema.bookDockManagedImports.id, input.operationId),
      eq(schema.bookDockManagedImports.libraryId, input.libraryId),
      eq(schema.bookDockManagedImports.userId, input.userId),
    );
  }

  async isPrepared(input: ManagedDockImport, authorize: AuthorizeManagedImport): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await authorize(tx);
      const [row] = await tx.select().from(schema.bookDockManagedImports).where(this.scope(input)).limit(1);
      if (!row) return false;
      if (row.state !== 'reserved') return true;
      const dock = await this.files.inspect(row.dockPath);
      return dock.status === 'stable' && dock.file.sha256 === row.sha256;
    });
  }

  private async recoverReservedInput(input: ManagedDockImport, row: ImportRow, authorize: AuthorizeManagedImport) {
    if (row.state !== 'reserved' || (await this.files.inspect(row.dockPath)).status !== 'missing') return;
    const fresh = await this.files.require(input.sourcePath);
    await this.manifests.inspect(input.sourcePath);
    await this.files.verifyUnchanged(input.sourcePath, fresh);
    await this.db.transaction(async (tx) => {
      await authorize(tx);
      const [locked] = await tx.select().from(schema.bookDockManagedImports).where(this.scope(input)).for('update');
      if (locked?.state === 'reserved' && (await this.files.inspect(locked.dockPath)).status === 'missing') {
        await tx
          .update(schema.bookDockManagedImports)
          .set({ sourcePath: input.sourcePath, sha256: fresh.sha256, sizeBytes: fresh.sizeBytes })
          .where(this.scope(input));
        await tx.update(schema.bookDockFiles).set({ fileSize: fresh.sizeBytes }).where(eq(schema.bookDockFiles.id, locked.dockFileId));
        await tx
          .update(schema.bookDockUnitFiles)
          .set({ fileSize: fresh.sizeBytes })
          .where(eq(schema.bookDockUnitFiles.dockFileId, locked.dockFileId));
      }
    });
  }

  private async reserve(input: ManagedDockImport, authorize: AuthorizeManagedImport) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) {
      throw new BadRequestException('Invalid managed import identity');
    }
    const existing = await this.db.transaction(async (tx) => {
      await authorize(tx);
      const [row] = await tx.select().from(schema.bookDockManagedImports).where(this.scope(input)).limit(1);
      return row;
    });
    if (existing) {
      if (existing.folderId !== input.folderId || resolve(existing.libraryRoot, input.relativePath) !== existing.destinationPath)
        throw new ConflictException('Managed import destination changed');
      await this.recoverReservedInput(input, existing, authorize);
      return;
    }
    const { library, folder } = await this.libraries.importDestination(input.libraryId, input.folderId);
    this.validator.validateFormat(input.relativePath, library.allowedFormats);
    if (!input.relativePath.toLowerCase().endsWith('.epub')) throw new BadRequestException('Managed story imports require an EPUB');
    const libraryRoot = await realpath(folder.path);
    const destinationPath = resolve(libraryRoot, input.relativePath);
    this.requireWithin(libraryRoot, destinationPath);
    const fresh = await this.files.require(input.sourcePath);
    if (fresh.sizeBytes > 512 * 1024 * 1024) throw new BadRequestException('Managed EPUB exceeds the size limit');
    await this.manifests.inspect(input.sourcePath);
    await this.files.verifyUnchanged(input.sourcePath, fresh);
    const unitDirectory = join(this.storage.bookDockPath, `managed-${input.operationId}`);
    const dockPath = join(unitDirectory, 'story.epub');
    await this.db.transaction(async (tx) => {
      await authorize(tx);
      const [dock] = await tx
        .insert(schema.bookDockFiles)
        .values({
          fileName: basename(destinationPath),
          absolutePath: dockPath,
          fileSize: fresh.sizeBytes,
          format: 'epub',
          unitDirectory,
          uploadedBy: input.userId,
          targetLibraryId: input.libraryId,
          targetFolderId: input.folderId,
          ingestionMode: 'managed',
          autoFinalizeSuppressed: true,
        })
        .onConflictDoNothing({ target: schema.bookDockFiles.absolutePath })
        .returning();
      if (!dock) {
        const [receipt] = await tx.select().from(schema.bookDockManagedImports).where(this.scope(input)).limit(1);
        if (!receipt || receipt.folderId !== input.folderId) throw new ConflictException('Managed import is already owned');
        return;
      }
      await tx.insert(schema.bookDockUnitFiles).values({
        dockFileId: dock.id,
        absolutePath: dockPath,
        fileName: 'story.epub',
        fileSize: fresh.sizeBytes,
        format: 'epub',
        role: 'content',
        sortOrder: 0,
      });
      await tx.insert(schema.bookDockManagedImports).values({
        id: input.operationId,
        libraryId: input.libraryId,
        folderId: input.folderId,
        userId: input.userId,
        dockFileId: dock.id,
        fileName: basename(destinationPath),
        sourcePath: input.sourcePath,
        dockPath,
        libraryRoot,
        destinationPath,
        bookFolderPath: library.organizationMode === 'book_per_file' ? destinationPath : dirname(destinationPath),
        sha256: fresh.sha256,
        sizeBytes: fresh.sizeBytes,
      });
    });
  }

  private async advance(input: ManagedDockImport, authorize: AuthorizeManagedImport): Promise<ImportRow> {
    return this.db.transaction(async (tx) => {
      await authorize(tx);
      const [row] = await tx.select().from(schema.bookDockManagedImports).where(this.scope(input)).for('update');
      if (!row) throw new NotFoundException('Managed import not found');
      if (row.state === 'cleanup_complete') {
        if (!row.bookId || !row.bookFileId) throw new NotFoundException('The imported book was deleted');
        return row;
      }
      await this.verifyDestination(row);
      let state: ImportRow['state'] = row.state;
      if (state === 'reserved') {
        await this.prepareDock(row);
        await tx.update(schema.bookDockFiles).set({ status: 'ready' }).where(eq(schema.bookDockFiles.id, row.dockFileId));
        state = 'prepared';
      } else if (state === 'prepared') {
        await this.publish(row, tx, authorize);
        state = 'filesystem_published';
      } else if (state === 'filesystem_published') {
        const fresh = await this.verifyPublication(row);
        await this.processor.createUnitBookRecords(
          row.libraryId,
          row.folderId,
          [
            {
              folderPath: row.bookFolderPath,
              absolutePath: row.destinationPath,
              relPath: relative(row.libraryRoot, row.destinationPath),
              format: 'epub',
              sizeBytes: row.sizeBytes,
            },
          ],
          tx,
        );
        const file = await this.processor.findPlacedFile(row.libraryId, row.destinationPath, tx);
        if (!file) throw new ConflictException('Managed file registration failed');
        await this.files.verifyUnchanged(row.destinationPath, fresh);
        const [committed] = await tx
          .update(schema.bookDockManagedImports)
          .set({ state: 'database_committed', bookId: file.bookId, bookFileId: file.id })
          .where(this.scope(input))
          .returning();
        return committed!;
      } else if (state === 'database_committed') {
        if (!row.bookId || !row.bookFileId) throw new NotFoundException('The imported book was deleted');
        await this.verifyPublication(row);
        await this.metadata.extractAndSave(row.bookId, row.destinationPath, 'epub');
        state = 'metadata_committed';
      } else if (state === 'metadata_committed') {
        await this.cleanup(row);
        await tx.delete(schema.bookDockFiles).where(eq(schema.bookDockFiles.id, row.dockFileId));
        state = 'cleanup_complete';
      }
      const [updated] = await tx.update(schema.bookDockManagedImports).set({ state }).where(this.scope(input)).returning();
      return updated!;
    });
  }

  private async prepareDock(row: ImportRow) {
    await mkdir(this.storage.bookDockPath, { recursive: true });
    const unit = dirname(row.dockPath);
    await this.makeDirectory(this.storage.bookDockPath, unit);
    const existing = await this.files.inspect(row.dockPath);
    if (existing.status === 'stable') {
      if (existing.file.sha256 !== row.sha256) throw new ConflictException('Managed Book Dock file changed');
      return;
    }
    if (existing.status !== 'missing') throw new ConflictException('Managed Book Dock file is not stable');
    const staged = join(unit, 'story.pending');
    await rm(staged, { force: true });
    await this.files.copy(row.sourcePath, staged);
    await this.files.require(staged, row.sha256);
    await rename(staged, row.dockPath);
    await this.files.sync(unit);
  }

  private stagePath(row: ImportRow) {
    return join(dirname(row.destinationPath), `.bookorbit-revision-${row.id}`, 'initial.epub');
  }

  private async publish(row: ImportRow, tx: DatabaseTransaction, authorize: AuthorizeManagedImport) {
    const stage = this.stagePath(row);
    await this.makeDirectory(row.libraryRoot, dirname(row.destinationPath));
    await this.makeDirectory(row.libraryRoot, dirname(stage));
    const existing = await this.files.inspect(stage);
    if (existing.status === 'missing') {
      await this.files.copy(row.dockPath, stage);
      await this.files.sync(dirname(stage));
    } else if (existing.status !== 'stable' || existing.file.sha256 !== row.sha256) {
      // An interrupted copy is rebuildable only while no published link refers to it.
      const destination = await lstat(row.destinationPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (destination) throw new ConflictException('An incomplete managed publication needs review');
      await rm(stage, { force: true });
      await this.files.copy(row.dockPath, stage);
      await this.files.sync(dirname(stage));
    }
    await this.files.require(stage, row.sha256);
    await authorize(tx);
    await this.verifyDestination(row);
    try {
      await link(stage, row.destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.verifyPublication(row);
    await this.files.sync(dirname(row.destinationPath));
  }

  private async verifyPublication(row: ImportRow) {
    const [stage, destination] = await Promise.all([lstat(this.stagePath(row), { bigint: true }), lstat(row.destinationPath, { bigint: true })]);
    if (!stage.isFile() || !destination.isFile() || stage.dev !== destination.dev || stage.ino !== destination.ino) {
      throw new ConflictException('The destination belongs to another file');
    }
    return this.files.require(row.destinationPath, row.sha256);
  }

  private async verifyDestination(row: ImportRow) {
    const { folder } = await this.libraries.importDestination(row.libraryId, row.folderId);
    if ((await realpath(folder.path)) !== row.libraryRoot) throw new ConflictException('Managed import library folder moved');
    this.requireWithin(row.libraryRoot, row.destinationPath);
    await this.verifyParents(row.libraryRoot, dirname(row.destinationPath));
  }

  private requireWithin(root: string, path: string) {
    const child = relative(root, path);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || child.includes('\0')) {
      throw new BadRequestException('Managed import destination must remain inside its library folder');
    }
  }

  private async verifyParents(root: string, directory: string) {
    const path = relative(root, directory);
    if (path) this.requireWithin(root, directory);
    let current = root;
    for (const segment of path.split(sep).filter(Boolean)) {
      current = join(current, segment);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new ConflictException('Managed import parent is not a regular directory');
    }
  }

  private async makeDirectory(root: string, directory: string) {
    await this.verifyParents(root, directory);
    let current = root;
    for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
      const parent = current;
      current = join(parent, segment);
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await this.verifyParents(root, current);
      await this.files.sync(parent);
    }
  }

  private async cleanup(row: ImportRow) {
    const dock = await this.files.inspect(row.dockPath);
    if (dock.status === 'stable' && dock.file.sha256 !== row.sha256) throw new ConflictException('Book Dock file changed before cleanup');
    if (dock.status === 'retryable') throw new ConflictException('Book Dock file could not be verified for cleanup');
    await rm(row.dockPath, { force: true });
    await rmdir(dirname(row.dockPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
    await rm(this.stagePath(row), { force: true });
    await rmdir(dirname(this.stagePath(row))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await this.files.sync(dirname(row.destinationPath));
    await this.files.sync(this.storage.bookDockPath);
  }
}
