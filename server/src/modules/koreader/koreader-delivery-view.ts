import type { KoreaderDeliveryJob } from '@bookorbit/types';
import { koreaderDeliveryJobs, koreaderInstalledCopies } from '../../db/schema';

export function deliveryView(
  job: typeof koreaderDeliveryJobs.$inferSelect,
  copy: Pick<typeof koreaderInstalledCopies.$inferSelect, 'copyId' | 'deviceId' | 'bookFileId'>,
): KoreaderDeliveryJob {
  return {
    id: job.id,
    installedCopyId: job.installedCopyId,
    copyId: copy.copyId,
    deviceId: copy.deviceId,
    bookFileId: copy.bookFileId,
    libraryId: job.libraryId,
    revisionId: job.revisionId,
    sha256: job.sha256,
    sizeBytes: job.sizeBytes,
    expectedLocalSha256: job.expectedLocalSha256,
    expectedLocalSizeBytes: job.expectedLocalSizeBytes,
    pathname: job.pathname,
    mode: job.mode,
    installationState: job.installationState,
    restorationState: job.restorationState,
    failureCode: job.failureCode,
    restorationFailureCode: job.restorationFailureCode,
    cancelledAt: job.cancelledAt?.toISOString() ?? null,
    version: job.version,
    attempt: job.attempt,
    installedAt: job.installedAt?.toISOString() ?? null,
    restoredAt: job.restoredAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
