import { execFile } from 'child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

import { BadRequestException, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { storageConfig } from '../../../config/config';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { EpubManifestService } from '../../book-revision/epub-manifest.service';
import { RevisionFileService } from '../../book-revision/revision-file.service';
import { KepubifyBinaryService } from './kepubify-binary.service';

const execFileAsync = promisify(execFile);
const KEPUBIFY_TIMEOUT_MS = 60_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

type SourceIdentity = Awaited<ReturnType<RevisionFileService['require']>>;
interface KepubConversionInput {
  sourcePath: string;
  fileHash?: string | null;
  bookId: number;
  hyphenate: boolean;
}

@Injectable()
export class KepubConversionService {
  private readonly logger = new Logger(KepubConversionService.name);
  private readonly kepubCachePath: string;
  private readonly sources = new Map<string, SourceIdentity>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    @Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>,
    private readonly kepubifyBinaryService: KepubifyBinaryService,
    private readonly files: RevisionFileService,
    private readonly manifests: EpubManifestService,
  ) {
    this.kepubCachePath = join(storage.appDataPath, '.kepub-cache');
  }

  async getKepubPath(input: KepubConversionInput): Promise<string> {
    const key = JSON.stringify([input.bookId, input.sourcePath, input.hyphenate]);
    const active = this.inFlight.get(key);
    if (active) return active;
    if (this.inFlight.size >= 2) throw new ServiceUnavailableException('Kobo conversion is busy; retry shortly');
    const pending = this.convert({ ...input })
      .catch((error: unknown) => {
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException('Kobo conversion failed; retry shortly', { cause: error });
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async sourceIdentity(path: string): Promise<SourceIdentity> {
    const cached = this.sources.get(path);
    if (cached) {
      try {
        await this.files.verifyUnchanged(path, cached);
        return cached;
      } catch {
        this.sources.delete(path);
      }
    }
    if ((await stat(path)).size > MAX_SOURCE_BYTES) throw new BadRequestException('EPUB exceeds the conversion size limit');
    const source = await this.files.require(path);
    this.sources.set(path, source);
    while (this.sources.size > 32) this.sources.delete(this.sources.keys().next().value!);
    return source;
  }

  private async convert(input: KepubConversionInput): Promise<string> {
    const source = await this.sourceIdentity(input.sourcePath);
    const version = await this.kepubifyBinaryService.getVersion();
    const cacheDir = join(this.kepubCachePath, String(input.bookId));
    const cacheKey = createHash('sha256')
      .update(JSON.stringify([source.sha256, version, input.hyphenate]))
      .digest('hex');
    const cachedPath = join(cacheDir, `v2-${cacheKey}.kepub.epub`);
    const cached = await stat(cachedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (cached?.isFile() && cached.size > 0) {
      await this.files.verifyUnchanged(input.sourcePath, source);
      return cachedPath;
    }

    const startedAt = Date.now();
    let working: string | undefined;
    this.logger.log(`[kobo.convert] [start] bookId=${input.bookId} hyphenate=${input.hyphenate} - Kobo conversion started`);
    try {
      await this.manifests.inspect(input.sourcePath);
      await this.files.verifyUnchanged(input.sourcePath, source);
      const binaryPath = await this.kepubifyBinaryService.getBinaryPath();
      await mkdir(cacheDir, { recursive: true });
      working = await mkdtemp(join(cacheDir, '.conversion-'));
      const staged = join(working, 'result.kepub.epub');
      const args = [...(input.hyphenate ? ['--hyphenate'] : []), '--output', staged, input.sourcePath];
      await execFileAsync(binaryPath, args, { timeout: KEPUBIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 });
      await this.manifests.inspect(staged);
      await this.files.sync(staged);
      await this.files.verifyUnchanged(input.sourcePath, source);
      await rename(staged, cachedPath);
      await this.files.sync(cacheDir);
      this.logger.log(`[kobo.convert] [end] bookId=${input.bookId} durationMs=${Date.now() - startedAt} - Kobo conversion completed`);
      return cachedPath;
    } catch (error) {
      this.logger.warn(
        `[kobo.convert] [fail] bookId=${input.bookId} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Unknown'} error="${sanitizeLogValue(error instanceof Error ? error.message : 'Conversion failed')}" - Kobo conversion failed`,
      );
      throw error;
    } finally {
      if (working) await rm(working, { recursive: true, force: true });
    }
  }
}
