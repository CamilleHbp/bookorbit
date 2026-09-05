import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { FanfictionWorkerService } from './fanfiction-worker.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionProfileService } from './fanfiction-profile.service';
import { FanficfareRuntimeService } from './fanficfare-runtime.service';
import { FanfictionImportService } from './fanfiction-import.service';
import { FanfictionUpdateService } from './fanfiction-update.service';
import { FanfictionRollbackService } from './fanfiction-rollback.service';
import { UserService } from '../user/user.service';

describe('Fanfiction queued execution', () => {
  it('runs rollback without decrypting a broken source profile or contacting FanFicFare', async () => {
    const job = { id: 'job', kind: 'rollback', libraryId: 5, userId: 7, tokenVersion: 1, profileId: 'broken-profile', attempts: 1 };
    const result = { revisionId: 'new-rollback-revision' };
    const jobs = {
      claim: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
      finish: vi.fn().mockResolvedValue(true),
      renew: vi.fn().mockResolvedValue(true),
    };
    const profiles = { document: vi.fn().mockRejectedValue(new Error('Encryption key unavailable')) };
    const runtime = { preview: vi.fn() };
    const rollback = { run: vi.fn().mockResolvedValue(result) };
    const module = await Test.createTestingModule({
      providers: [
        FanfictionWorkerService,
        { provide: FanfictionJobService, useValue: jobs },
        { provide: FanfictionProfileService, useValue: profiles },
        { provide: FanfictionAccessService, useValue: { administer: vi.fn() } },
        { provide: FanficfareRuntimeService, useValue: runtime },
        { provide: UserService, useValue: { findByIdWithPermissions: vi.fn().mockResolvedValue({ id: 7, tokenVersion: 1 }) } },
        { provide: FanfictionImportService, useValue: {} },
        { provide: FanfictionUpdateService, useValue: {} },
        { provide: FanfictionRollbackService, useValue: rollback },
      ],
    }).compile();
    const worker = module.get(FanfictionWorkerService);
    try {
      await worker.tick();
      await vi.waitFor(() => expect(jobs.finish).toHaveBeenCalledWith(job, 'succeeded', result));
      expect(rollback.run).toHaveBeenCalledOnce();
      expect(profiles.document).not.toHaveBeenCalled();
      expect(runtime.preview).not.toHaveBeenCalled();
    } finally {
      await worker.onModuleDestroy();
      await module.close();
    }
  });
});
