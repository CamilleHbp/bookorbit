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
import { FanfictionDiscoveryService } from './fanfiction-discovery.service';
import { FanfictionAdoptionService } from './fanfiction-adoption.service';
import { FanfictionSourceBatchService } from './fanfiction-source-batch.service';
import { UserService } from '../user/user.service';

describe('Fanfiction queued execution', () => {
  it.each(['rollback', 'discovery', 'adopt', 'source_batch'] as const)(
    'runs %s without decrypting a profile or contacting FanFicFare',
    async (kind) => {
      const job = { id: 'job', kind, libraryId: 5, userId: 7, tokenVersion: 1, profileId: 'broken-profile', attempts: 1 };
      const result =
        kind === 'rollback'
          ? { revisionId: 'new-rollback-revision' }
          : kind === 'discovery'
            ? { discovery: { finished: false } }
            : { selection: { processed: 3, failed: 1, finished: true } };
      const jobs = {
        claim: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
        finish: vi.fn().mockResolvedValue(true),
        yieldBatch: vi.fn().mockResolvedValue(true),
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
          { provide: FanfictionDiscoveryService, useValue: rollback },
          { provide: FanfictionAdoptionService, useValue: rollback },
          { provide: FanfictionSourceBatchService, useValue: rollback },
        ],
      }).compile();
      const worker = module.get(FanfictionWorkerService);
      try {
        await worker.tick();
        if (kind === 'discovery') {
          await vi.waitFor(() => expect(jobs.yieldBatch).toHaveBeenCalledWith(job, result));
          expect(jobs.finish).not.toHaveBeenCalled();
        } else
          await vi.waitFor(() =>
            expect(jobs.finish).toHaveBeenCalledWith(
              job,
              ['adopt', 'source_batch'].includes(kind) ? 'review_required' : 'succeeded',
              result,
              kind === 'adopt' ? 'discovery_review_required' : kind === 'source_batch' ? 'source_batch_review_required' : null,
            ),
          );
        expect(rollback.run).toHaveBeenCalledOnce();
        expect(profiles.document).not.toHaveBeenCalled();
        expect(runtime.preview).not.toHaveBeenCalled();
      } finally {
        await worker.onModuleDestroy();
        await module.close();
      }
    },
  );
});
