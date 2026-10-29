import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { DB } from '../../db';
import type { RequestUser } from '../../common/types/request-user';
import { RevisionDownloadService } from '../book-revision/revision-download.service';
import { KoreaderDeliveryAccessService } from './koreader-delivery-access.service';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';

describe('delivery rejection during failure persistence outages', () => {
  const user = { id: 7 } as RequestUser;
  const lease = { deviceId: 'reader', token: 'lease-token', fence: 2 };
  const job = {
    id: 'job',
    userId: 7,
    installedCopyId: 'copy',
    libraryId: 5,
    revisionId: 'revision',
    sha256: 'new',
    sizeBytes: 20,
    expectedLocalSha256: 'old',
    expectedLocalSizeBytes: 10,
    pathname: '/books/story.epub',
    mode: 'manual',
    installationState: 'downloading',
    leaseToken: lease.token,
    fence: lease.fence,
    leaseExpiresAt: new Date(Date.now() + 300_000),
  };
  async function setup() {
    const read = { from: vi.fn(), where: vi.fn(), limit: vi.fn().mockResolvedValue([job]) };
    read.from.mockReturnValue(read);
    read.where.mockReturnValue(read);
    const write = { set: vi.fn(), where: vi.fn().mockRejectedValue(new Error('Database write unavailable')) };
    write.set.mockReturnValue(write);
    const db = { select: vi.fn().mockReturnValue(read), update: vi.fn().mockReturnValue(write) };
    const access = {
      copy: vi.fn().mockResolvedValue({
        copy: { bookFileId: 9, pathname: job.pathname, sha256: 'old', sizeBytes: 10 },
        device: { deliveryCapabilityVersion: 1, positionCapabilityVersion: 1 },
        file: { libraryId: 5, currentRevisionId: 'revision', sha256: 'new', sizeBytes: 20 },
      }),
    };
    const downloads = { download: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        KoreaderDeliveryExecutionService,
        { provide: DB, useValue: db },
        { provide: KoreaderDeliveryAccessService, useValue: access },
        { provide: RevisionDownloadService, useValue: downloads },
      ],
    }).compile();
    return { module, execution: module.get(KoreaderDeliveryExecutionService), access, downloads, db };
  }

  it('preserves the original access rejection before claiming work', async () => {
    const { module, execution, access, downloads, db } = await setup();
    const denied = new ForbiddenException('Library access revoked');
    access.copy.mockRejectedValue(denied);
    try {
      await expect(execution.claim(job.id, { deviceId: 'reader', claimId: 'claim' }, user)).rejects.toBe(denied);
      expect(db.update).toHaveBeenCalledOnce();
      expect(downloads.download).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });

  it('preserves a stale revision rejection without opening a download', async () => {
    const { module, execution, access, downloads, db } = await setup();
    access.copy.mockResolvedValue({
      copy: {},
      device: { deliveryCapabilityVersion: 1, positionCapabilityVersion: 1 },
      file: { libraryId: 5, currentRevisionId: 'changed' },
    });
    try {
      await expect(execution.download(job.id, lease, user, () => false)).rejects.toThrow('expected server revision changed');
      expect(db.update).toHaveBeenCalledOnce();
      expect(downloads.download).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });

  it('stops streaming with the original access rejection when saving the blocked state fails', async () => {
    const { module, execution, access, downloads, db } = await setup();
    const result = { stream: 'snapshot' };
    downloads.download.mockResolvedValue(result);
    try {
      expect(await execution.download(job.id, lease, user, () => false)).toBe(result);
      const authorize = downloads.download.mock.calls[0][3] as () => Promise<void>;
      const denied = new ForbiddenException('Download permission revoked');
      access.copy.mockRejectedValue(denied);
      await expect(authorize()).rejects.toBe(denied);
      expect(db.update).toHaveBeenCalledOnce();
    } finally {
      await module.close();
    }
  });
});
