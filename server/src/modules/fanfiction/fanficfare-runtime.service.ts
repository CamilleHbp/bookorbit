import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type {
  FanficfareRuntimeHealth,
  FanficfareSiteCatalog,
  FanfictionPreview,
  FanfictionProfileDocument,
  FanfictionRecognizedUrl,
} from '@bookorbit/types';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fanficfareConfig, storageConfig } from '../../config/config';
import { validateFanfictionPreview } from './fanfiction-preview';
import { validateRuntimeCookies, type FanfictionCookieSink } from './fanfiction-cookies';
import { FanfictionRuntimeProgress, type FanfictionProgressSink } from './fanfiction-runtime-progress';

type RuntimeRequest = {
  operation: 'health' | 'sites' | 'recognize' | 'validate' | 'merge' | 'preview' | 'download' | 'update' | 'refresh';
  urls?: string[];
  url?: string;
  configuration?: string;
  cookies?: FanfictionProfileDocument['cookies'];
  previous?: string;
  edits?: { section?: string; username?: string; password?: string; isAdult?: boolean };
  redact?: boolean;
};
type RuntimeResponse = { ok: true; result: unknown; cookies?: unknown } | { ok: false; code: string; errorClass: string };

@Injectable()
export class FanficfareRuntimeService {
  private active = 0;

  constructor(
    @Inject(fanficfareConfig.KEY) private readonly config: ConfigType<typeof fanficfareConfig>,
    @Inject(storageConfig.KEY) private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async health(): Promise<FanficfareRuntimeHealth> {
    try {
      const result = (await this.temporary({ operation: 'health' })) as FanficfareRuntimeHealth;
      if (result.version !== '4.61.0' || result.protocolVersion !== 1 || result.ready !== true) throw new ServiceUnavailableException();
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
      return { url: urls[index], recognized: true, canonicalUrl: canonical.href, site: item.site };
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
    document: FanfictionProfileDocument,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
  ): Promise<FanfictionPreview> {
    return validateFanfictionPreview(await this.temporary({ operation: 'preview', url, ...document }, signal, saveCookies));
  }

  async download<T>(
    url: string,
    document: FanfictionProfileDocument,
    consume: (path: string, preview: FanfictionPreview) => Promise<T>,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reportProgress?: FanfictionProgressSink,
  ): Promise<T> {
    return this.workspace(async (directory) => {
      const result = (await this.execute({ operation: 'download', url, ...document }, directory, signal, saveCookies, reportProgress)) as {
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
    document: FanfictionProfileDocument,
    prepare: (inputPath: string) => Promise<void>,
    consume: (path: string, preview: FanfictionPreview) => Promise<T>,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
  ): Promise<T> {
    return this.workspace(async (directory) => {
      await prepare(join(directory, 'input.epub'));
      const result = (await this.execute({ operation, url, ...document }, directory, signal, saveCookies)) as {
        output?: string;
        reviewRequired?: string;
        preview?: FanfictionPreview;
      };
      if (result.reviewRequired)
        throw new BadRequestException({ message: 'Story identity or chapter count requires review', errorCode: 'review_required' });
      if (result.output !== 'output.epub' || !result.preview) throw new ServiceUnavailableException('Invalid FanFicFare update response');
      return consume(join(directory, 'output.epub'), validateFanfictionPreview(result.preview));
    });
  }

  async execute(
    request: RuntimeRequest,
    workspace: string,
    signal?: AbortSignal,
    saveCookies?: FanfictionCookieSink,
    reportProgress?: FanfictionProgressSink,
  ): Promise<unknown> {
    if (this.active >= this.config.maxWorkers) throw new ServiceUnavailableException('FanFicFare runtime is busy');
    if (signal?.aborted) throw new ServiceUnavailableException('FanFicFare operation cancelled');
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 512 * 1024) throw new BadRequestException('FanFicFare input limit exceeded');
    this.active++;
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
        }, this.config.timeoutMs);
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
            if (response.ok !== true)
              return reject(new BadRequestException({ message: 'FanFicFare could not complete the operation', errorCode: response.code }));
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
      this.active--;
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
