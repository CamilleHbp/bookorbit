import { createHash } from 'node:crypto';
import type { KoreaderCopyInventoryResult, KoreaderInstalledCopyReport } from '@bookorbit/types';
import { koreaderInstalledCopies as copies, koreaderDeliveryDevices as devices } from '../../db/schema';

export const copyInventoryHash = (value: string) => createHash('sha256').update(value).digest('hex');

export function planCopyReports(
  reports: KoreaderInstalledCopyReport[],
  sequence: number,
  device: typeof devices.$inferSelect,
  existing: (typeof copies.$inferSelect)[],
  identity: Map<string, string | null>,
  allowed: Set<number>,
) {
  const paths = reports.map((copy) => copyInventoryHash(copy.pathname));
  const byCopy = new Map(existing.map((copy) => [copy.copyId, copy]));
  const byPath = new Map(existing.map((copy) => [copy.pathnameHash, copy.copyId]));
  const pathCounts = new Map<string, number>();
  for (const path of paths) pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  const results: KoreaderCopyInventoryResult['copies'] = [];
  const writes: (typeof copies.$inferInsert)[] = [];
  for (const report of reports) {
    if (!allowed.has(report.bookFileId)) {
      results.push({ copyId: report.copyId, status: 'unavailable' });
      continue;
    }
    const previous = byCopy.get(report.copyId);
    const pathnameHash = copyInventoryHash(report.pathname);
    const revisionId = identity.get(report.copyId) ?? null;
    const reportHash = copyInventoryHash(
      JSON.stringify([
        report.bookFileId,
        report.pathname,
        report.sha256,
        report.sizeBytes,
        report.revisionId ?? null,
        report.policyAcknowledgement ?? null,
      ]),
    );
    const policy = previous?.policy ?? device.policy;
    const effectivePolicyVersion = `${device.policyVersion}:${previous?.policyVersion ?? 1}`;
    if (
      (report.revisionId && !revisionId) ||
      (previous && previous.bookFileId !== report.bookFileId) ||
      pathCounts.get(pathnameHash)! > 1 ||
      (byPath.has(pathnameHash) && byPath.get(pathnameHash) !== report.copyId) ||
      (previous?.reportSequence === sequence && previous.reportHash !== reportHash)
    ) {
      results.push({ copyId: report.copyId, status: 'conflict' });
      continue;
    }
    if (previous && previous.reportSequence > sequence) {
      results.push({ copyId: report.copyId, status: 'stale', id: previous.id, revisionId: previous.revisionId, policy, effectivePolicyVersion });
      continue;
    }
    const policyAcknowledgement =
      report.policyAcknowledgement === effectivePolicyVersion ? effectivePolicyVersion : (previous?.policyAcknowledgement ?? null);
    writes.push({
      userId: device.userId,
      deviceId: device.deviceId,
      copyId: report.copyId,
      bookFileId: report.bookFileId,
      pathname: report.pathname,
      pathnameHash,
      sha256: report.sha256,
      sizeBytes: report.sizeBytes,
      revisionId,
      reportSequence: sequence,
      reportHash,
      policyAcknowledgement,
    });
    results.push({
      copyId: report.copyId,
      status: previous?.reportSequence === sequence ? 'unchanged' : 'accepted',
      revisionId,
      policy,
      effectivePolicyVersion,
    });
  }
  return { writes, results };
}
