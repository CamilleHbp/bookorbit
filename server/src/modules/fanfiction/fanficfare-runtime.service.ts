import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type {
  FanficfareRuntimeHealth,
  FanficfareSiteCatalog,
  FanfictionPreview,
  FanfictionConnectionDocument,
  FanfictionRecognizedUrl,
} from '@bookorbit/types';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fanficfareConfig, storageConfig } from '../../config/config';
import { validateFanfictionPreview } from './fanfiction-preview';
import { validateRuntimeCookies, type FanfictionCookieSink } from './fanfiction-cookies';
import { FanfictionRuntimeProgress, type FanfictionProgressSink } from './fanfiction-runtime-progress';

export type ChapterScope = { libraryId: number; userId: number; sourceId: string; restartId?: string };

type RuntimeRequest = {
  operation: 'health' | 'sites' | 'recognize' | 'validate' | 'merge' | 'preview' | 'download' | 'update' | 'refresh';
  urls?: string[];
  url?: string;
  configuration?: string;
  cookies?: FanfictionConnectionDocument['cookies'];
  tagRules?: FanfictionConnectionDocument['tagRules'];
  previous?: string;
  edits?: { section?: string; username?: string; password?: string; isAdult?: boolean };
  redact?: boolean;
  reviewChanges?: boolean;
  chapterDirectory?: string;
  checkStatePath?: string;
};
type RuntimeResponse =
  { ok: true; result: unknown; cookies?: unknown } | { ok: false; code: string; errorClass: string; errorLocation?: string; httpStatus?: number };

@Injectable()
export class FanficfareRuntimeService {
  private readonly logger = new Logger(FanficfareRuntimeService.name);
  // Recognition depends only on the pinned adapters. Cache successful URL lookups
  // so repeated legacy-library checks do not repeatedly start Python for the same batch.
  private readonly recognized = new Map<string, FanfictionRecognizedUrl>();
  private active = 0;
  private controlPending = 0;
  private controlTail: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(fanficfareConfig.KEY) private readonly config: ConfigType<typeof fanficfareConfig>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async health(): Promise<FanficfareRuntimeHealth> {
    try {
      const result = (await this.temporary({ operation: 'health' })) as FanficfareRuntimeHealth;
      if (result.version !== '4.63.0' || result.protocolVersion !== 1 || result.ready !== true) throw new ServiceUnavailableException();
      return result;
    } catch {
      return { version: null, protocolVersion: 1, ready: false, errorCode: 'runtime_unavailable' };
    }
  }

  async sites(): Promise<FanficfareSiteCatalog> {
    const result = (await this.temporary({ operation: 'sites' })) as FanficfareSiteCatalog;
    if (!Array.isArray(result.sites) || result.sites.length > 2000) throw new ServiceUnavailableException('Invalid runtime site catalog');
    return result;
  }

  async validateConfiguration(configuration: string): Promise<void> {
    await this.temporary({ operation: 'validate', configuration });
  }

  async recognize(urls: string[], signal?: AbortSignal): Promise<FanfictionRecognizedUrl[]> {
    if (!urls.length || urls.length > 100 || urls.some((url) => typeof url !== 'string' || url.length > 4096))
      throw new BadRequestException('URL recognition requires a bounded batch');
    signal?.throwIfAborted();
    const found = new Map<string, FanfictionRecognizedUrl>();
    for (const url of urls) {
      const cached = this.recognized.get(url);
      if (cached) found.set(url, cached);
    }
    const missing = [...new Set(urls.filter((url) => !found.has(url)))];
    if (missing.length) {
      for (const item of await this.recognizeBatch(missing, signal)) {
        found.set(item.url, item);
        if (item.recognized) this.recognized.set(item.url, item);
      }
      while (this.recognized.size > 4096) this.recognized.delete(this.recognized.keys().next().value!);
    }
    return urls.map((url) => found.get(url)!);
  }

  private async recognizeBatch(urls: string[], signal?: AbortSignal): Promise<FanfictionRecognizedUrl[]> {
    const result = await this.temporary({ operation: 'recognize', urls }, signal);
    if (!Array.isArray(result) || result.length !== urls.length) throw new ServiceUnavailableException('Invalid URL recognition response');
    return result.map((item: unknown, index) => {
      if (!item || typeof item !== 'object' || !('url' in item) || item.url !== urls[index] || !('recognized' in item))
        throw new ServiceUnavailableException('Invalid URL recognition identity');
      if (item.recognized === false && 'reason' in item && ['unsupported', 'unsafe', 'access_required'].includes(String(item.reason)))
        return { url: urls[index], recognized: false, reason: item.reason } as FanfictionRecognizedUrl;
      if (
        item.recognized !== true ||
        !('canonicalUrl' in item) ||
        typeof item.canonicalUrl !== 'string' ||
        item.canonicalUrl.length > 4096 ||
        !('site' in item) ||
        typeof item.site !== 'string' ||
        !item.site ||
        item.site.length > 255
      )
        throw new ServiceUnavailableException('Invalid recognized story identity');
      let canonical: URL;
      try {
        canonical = new URL(item.canonicalUrl);
      } catch {
        throw new ServiceUnavailableException('Invalid canonical URL');
      }
      if (canonical.protocol !== 'https:' || canonical.username || canonical.password || (canonical.port && canonical.port !== '443'))
        throw new ServiceUnavailableException('Unsafe canonical URL');
      canonical.hash = '';
      const identityUrl = 'identityUrl' in item ? item.identityUrl : undefined;
      if (identityUrl !== undefined && (typeof identityUrl !== 'string' || !identityUrl || identityUrl.length > 4096))
        throw new ServiceUnavailableException('Invalid adapter story identity');
      return {
        url: urls[index],
        recognized: true,
        canonicalUrl: canonical.href,
        site: item.site,
        ...(typeof identityUrl === 'string' && { identityUrl }),
      };
    });
  }

  async mergeConfiguration(previous: string, configuration?: string, edits?: RuntimeRequest['edits'], redact = false): Promise<string> {
    const result = (await this.temporary({ operation: 'merge', previous, configuration, edits, redact })) as { configuration: string };
    if (typeof result.configuration !== 'string' || Buffer.byteLength(result.configuration) > 65536)
      throw new ServiceUnavailableException('Invalid configuration response');
    return result.configuration;
  }

  async preview(
    url: string,
    document: FanfictionConnectionDocument,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
  ): Promise<FanfictionPreview> {
    return validateFanfictionPreview(await this.temporary({ operation: 'preview', url, ...document }, signal, saveCookies));
  }

  private chapterDirectory(scope?: ChapterScope) {
    if (!scope) return undefined;
    const { libraryId, userId, sourceId, restartId } = scope;
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (
      !Number.isSafeInteger(libraryId) ||
      libraryId < 1 ||
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      !uuid.test(sourceId) ||
      (restartId && !uuid.test(restartId))
    )
      throw new BadRequestException('Invalid story download identity');
    return join(this.storage.appDataPath, 'fanfiction', 'chapters', String(libraryId), String(userId), sourceId, restartId ?? 'incremental');
  }

  async releaseChapters(scope: ChapterScope) {
    try {
      await rm(this.chapterDirectory(scope)!, { recursive: true, force: true });
    } catch {
      this.logger.warn(
        `[fanfiction.chapter_cleanup] [fail] libraryId=${scope.libraryId} sourceId=${scope.sourceId} - saved chapter cleanup deferred`,
      );
    }
  }

  async download<T>(
    url: string,
    document: FanfictionConnectionDocument,
    consume: (path: string, preview: FanfictionPreview) => Promise<T>,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reportProgress?: FanfictionProgressSink,
    scope?: ChapterScope,
  ): Promise<T> {
    return this.workspace(async (directory) => {
      const result = (await this.execute(
        {
          operation: 'download',
          url,
          ...document,
          chapterDirectory: this.chapterDirectory(scope),
          checkStatePath: scope ? join(this.chapterDirectory(scope)!, '..', 'check.json') : undefined,
        },
        directory,
        signal,
        saveCookies,
        reportProgress,
      )) as {
        output?: string;
        preview?: FanfictionPreview;
      };
      if (result.output !== 'output.epub' || !result.preview) throw new ServiceUnavailableException('Invalid FanFicFare download response');
      return consume(join(directory, 'output.epub'), validateFanfictionPreview(result.preview));
    });
  }

  async update<T>(
    operation: 'update' | 'refresh',
    url: string,
    document: FanfictionConnectionDocument,
    prepare: (inputPath: string) => Promise<void>,
    consume: (path: string, preview: FanfictionPreview, unchangedEdition?: boolean) => Promise<T>,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reviewChanges = false,
    scope?: ChapterScope,
    reportProgress?: FanfictionProgressSink,
  ): Promise<T> {
    return this.workspace(async (directory) => {
      await prepare(join(directory, 'input.epub'));
      const result = (await this.execute(
        {
          operation,
          url,
          ...document,
          reviewChanges,
          chapterDirectory: this.chapterDirectory(scope),
          checkStatePath: scope ? join(this.chapterDirectory(scope)!, '..', 'check.json') : undefined,
        },
        directory,
        signal,
        saveCookies,
        reportProgress,
      )) as {
        output?: string;
        unchangedEdition?: boolean;
        reviewRequired?: string;
        preview?: FanfictionPreview;
      };
      if (result.reviewRequired)
        throw new BadRequestException({
          message:
            result.reviewRequired === 'chapter_reduction'
              ? 'The website has fewer chapters than the saved EPUB'
              : 'The saved EPUB points to a different story',
          errorCode: result.reviewRequired === 'chapter_reduction' ? 'source_chapter_reduction' : 'source_identity_mismatch',
        });
      if (!['output.epub', 'input.epub'].includes(result.output ?? '') || !result.preview)
        throw new ServiceUnavailableException('Invalid FanFicFare update response');
      const output = join(directory, result.output!);
      const preview = validateFanfictionPreview(result.preview);
      const consumed =
        result.output === 'input.epub' && result.unchangedEdition === true ? await consume(output, preview, true) : await consume(output, preview);
      if (
        scope &&
        result.output === 'output.epub' &&
        consumed &&
        typeof consumed === 'object' &&
        'noChange' in consumed &&
        consumed.noChange === true
      )
        await this.confirmUnchanged(scope, directory);
      return consumed;
    });
  }

  private async confirmUnchanged(scope: ChapterScope, directory: string) {
    const startedAt = Date.now();
    const path = join(this.chapterDirectory(scope)!, '..', 'check.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const hash = async (name: string) => {
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(join(directory, name))) digest.update(chunk);
        return digest.digest('hex');
      };
      const [inputHash, outputHash] = await Promise.all([hash('input.epub'), hash('output.epub')]);
      const state = JSON.parse(await readFile(path, 'utf8')) as { epubHash?: string };
      if (state.epubHash !== outputHash) return;
      // Semantic equality can leave the original ZIP installed. Bind the verified
      // source snapshot to those exact bytes rather than the discarded new ZIP.
      await writeFile(temporary, JSON.stringify({ ...state, epubHash: inputHash }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch {
      this.logger.warn(
        `[fanfiction.check_cache] [fail] libraryId=${scope.libraryId} sourceId=${scope.sourceId} durationMs=${Date.now() - startedAt} errorClass=CacheStateError - source verification cache will be rebuilt`,
      );
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async execute(
    request: RuntimeRequest,
    workspace: string,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reportProgress?: FanfictionProgressSink,
  ): Promise<unknown> {
    // Local catalog/configuration work must remain available while downloads run.
    const control = ['health', 'sites', 'validate', 'merge', 'recognize'].includes(request.operation);
    if (!control) return this.executeWorker(request, workspace, signal, saveCookies, reportProgress);
    if (this.controlPending >= 32) throw new ServiceUnavailableException('Too many website settings requests; try again shortly');
    this.controlPending++;
    const result = this.controlTail.then(() => this.executeWorker(request, workspace, signal, saveCookies, reportProgress, true));
    this.controlTail = result.catch(() => {});
    try {
      return await result;
    } finally {
      this.controlPending--;
    }
  }

  private async executeWorker(
    request: RuntimeRequest,
    workspace: string,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reportProgress?: FanfictionProgressSink,
    control = false,
  ): Promise<unknown> {
    if (!control && this.active >= this.config.maxWorkers) throw new ServiceUnavailableException('FanFicFare runtime is busy');
    if (signal?.aborted) throw new ServiceUnavailableException('FanFicFare operation cancelled');
    const browserDownload =
      ['download', 'update', 'refresh'].includes(request.operation) &&
      (this.config.flaresolverrUrl || /^https:\/\/(?:www\.)?royalroad\.com\//.test(request.url ?? ''));
    const timeoutMs = control
      ? Math.min(this.config.timeoutMs, request.operation === 'recognize' ? 60_000 : 5000)
      : browserDownload
        ? 7_200_000
        : this.config.timeoutMs;
    const input = JSON.stringify({
      ...request,
      timeoutSeconds: Math.ceil((control ? timeoutMs : this.config.timeoutMs) / 1000),
      ...(browserDownload ? { browserTimeoutSeconds: 7200 } : {}),
      ...(this.config.flaresolverrUrl ? { flaresolverrUrl: this.config.flaresolverrUrl } : {}),
    });
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new BadRequestException('FanFicFare input limit exceeded');
    if (!control) this.active++;
    const startedAt = Date.now();
    const progress = new FanfictionRuntimeProgress(reportProgress);
    try {
      const response = await new Promise<Extract<RuntimeResponse, { ok: true }>>((resolve, reject) => {
        const child = spawn(this.config.python, ['-I', join(__dirname, 'runtime', 'fanficfare_wrapper.py')], {
          cwd: workspace,
          env: { HOME: workspace, TMPDIR: workspace, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let failed = false;
        let timedOut = false;
        const stop = () => {
          failed = true;
          child.kill('SIGKILL');
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        signal?.addEventListener('abort', stop, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) stop();
          else chunks.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) stop();
          else progress.feed(chunk);
        });
        child.stdin.on('error', () => {
          /* Early process exit is handled by close. */
        });
        child.once('error', () => {
          failed = true;
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
          if (failed || code !== 0)
            return reject(
              new ServiceUnavailableException({
                message: 'Story download could not finish',
                errorCode: timedOut ? 'download_timeout' : 'runtime_unavailable',
              }),
            );
          try {
            const response = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RuntimeResponse;
            if (response.ok !== true) {
              const diagnostic = (value: unknown) => (typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_.:]/g, '').slice(0, 160) : 'unknown');
              this.logger.warn(
                `[fanfiction.runtime] [fail] operation=${request.operation} durationMs=${Date.now() - startedAt} errorClass=${diagnostic(response.errorClass)} errorCode=${diagnostic(response.code)} location=${diagnostic(response.errorLocation)} httpStatus=${Number.isInteger(response.httpStatus) && response.httpStatus! >= 400 && response.httpStatus! <= 599 ? response.httpStatus : 'unknown'} - story operation failed`,
              );
              return reject(new BadRequestException({ message: 'FanFicFare could not complete the operation', errorCode: response.code }));
            }
            resolve(response);
          } catch {
            reject(new ServiceUnavailableException('Invalid FanFicFare runtime response'));
          }
        });
        child.stdin.end(input);
      });
      await progress.flush();
      if (saveCookies) {
        if (signal?.aborted) throw new ServiceUnavailableException('FanFicFare operation cancelled');
        await saveCookies(validateRuntimeCookies(response.cookies));
      }
      return response.result;
    } finally {
      await progress.flush().catch(() => {});
      if (!control) this.active--;
    }
  }

  private async temporary(request: RuntimeRequest, signal?: AbortSignal, saveCookies?: FanfictionCookieSink): Promise<unknown> {
    return this.workspace((directory) => this.execute(request, directory, signal, saveCookies));
  }

  private async workspace<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    const root = join(this.storage.appDataPath, 'fanfiction', 'runtime');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, 'operation-'));
    try {
      return await operation(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
