import type { FanfictionJobKind } from '@bookorbit/types';

export const chapterDownloadKinds = ['import', 'update', 'refresh'] satisfies FanfictionJobKind[];

export function isChapterDownload(kind: FanfictionJobKind): boolean {
  return chapterDownloadKinds.some((download) => download === kind);
}

export function shouldRetryJob(kind: FanfictionJobKind, attempts: number, code: string, transient: boolean): boolean {
  if (isChapterDownload(kind)) {
    return (
      transient ||
      [
        'source_failed',
        'source_rate_limited',
        'source_unavailable',
        'download_timeout',
        'runtime_unavailable',
        'worker_lease_expired',
        'chapter_storage_failed',
      ].includes(code)
    );
  }
  return (
    attempts < 3 &&
    ![
      'download_limit',
      'response_too_large',
      'source_policy_blocked',
      'invalid_epub',
      'source_not_found',
      'tag_matches_changed_after_publication',
    ].includes(code)
  );
}

export function retryDelaySeconds(kind: FanfictionJobKind, attempts: number): number {
  const ceiling = isChapterDownload(kind) ? 3600 : 300;
  const delay = Math.min(ceiling, 15 * 2 ** Math.min(attempts, 8));
  return Math.min(ceiling, delay + Math.floor(Math.random() * 15));
}
