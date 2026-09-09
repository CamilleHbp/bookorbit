import type { FanfictionImportProgress } from '@bookorbit/types';
import { ServiceUnavailableException } from '@nestjs/common';

export type FanfictionProgressSink = (progress: FanfictionImportProgress) => Promise<void>;

/** Coalesce updates while persistence is busy, keeping at most one pending value. */
export class FanfictionRuntimeProgress {
  private buffer = '';
  private pending?: FanfictionImportProgress;
  private writing?: Promise<void>;
  private failure?: Error;

  constructor(private readonly sink?: FanfictionProgressSink) {}

  feed(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!this.sink || !line.startsWith('BOOKORBIT_PROGRESS ')) continue;
      try {
        const value = JSON.parse(line.slice(19)) as FanfictionImportProgress;
        if (!['metadata', 'downloading', 'packaging', 'validating'].includes(value.stage)) continue;
        const { completedChapters, totalChapters } = value;
        if (
          value.stage !== 'metadata' &&
          (!Number.isInteger(totalChapters) ||
            totalChapters! < 1 ||
            totalChapters! > 10_000 ||
            !Number.isInteger(completedChapters) ||
            completedChapters! < 0 ||
            completedChapters! > totalChapters!)
        )
          continue;
        this.pending = { stage: value.stage, ...(value.stage !== 'metadata' ? { completedChapters, totalChapters } : {}) };
        this.start();
      } catch {
        /* Ignore non-protocol diagnostics without exposing their contents. */
      }
    }
    if (this.buffer.length > 4096) this.buffer = '';
  }

  private start(): void {
    if (this.writing || this.failure) return;
    this.writing = this.drain()
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new ServiceUnavailableException('Import progress could not be saved');
      })
      .finally(() => {
        this.writing = undefined;
        if (this.pending && !this.failure) this.start();
      });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const progress = this.pending;
      this.pending = undefined;
      await this.sink?.(progress);
    }
  }

  async flush(): Promise<void> {
    while (this.writing) await this.writing;
    if (this.failure) throw this.failure;
  }
}
