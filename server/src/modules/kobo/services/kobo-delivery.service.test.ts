import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { KoboDeliveryService, deliveryErrorCode, type KoboDeliveryRecord } from './kobo-delivery.service';

function record(overrides: Partial<KoboDeliveryRecord> = {}): KoboDeliveryRecord {
  return {
    id: 'stale',
    userId: 1,
    deviceId: 2,
    bookId: 3,
    sourceFileId: 4,
    metadata: {
      artifactId: 'artifact',
      sourceRevision: 'revision',
      requestedVariant: null,
      actualVariant: 'original',
      format: 'kepub',
      sizeBytes: 100,
      sha256: 'sha',
      fileHash: 'hash',
      outcome: 'original',
    },
    options: { hyphenate: false, converterVersion: 'v1' },
    state: 'transfer_observed',
    previousId: null,
    current: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  const repository = {
    retire: vi.fn().mockResolvedValue(undefined),
    reoffer: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn().mockResolvedValue([{}]),
    adoptForDeviceReadingState: vi.fn().mockResolvedValue(undefined),
  };
  const service = new KoboDeliveryService(repository as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const offer = vi.spyOn(service, 'offer');
  const resolve = vi.spyOn(service, 'resolve');
  const artifact = (id: string) => ({ path: `/cache/${id}`, release: vi.fn() }) as never;
  return { service, repository, offer, resolve, artifact };
}

describe('KoboDeliveryService.prepareDownload', () => {
  it('serves the current offer when its source still rebuilds it', async () => {
    const { service, repository, offer, resolve, artifact } = makeService();
    const current = record();
    offer.mockResolvedValue(current);
    resolve.mockResolvedValue(artifact('stale'));

    const result = await service.prepareDownload(1, 2, 3, 'stale');

    expect(result.record).toBe(current);
    expect(repository.retire).not.toHaveBeenCalled();
    expect(repository.reoffer).not.toHaveBeenCalled();
  });

  it.each(['DELIVERY_SOURCE_CHANGED', 'DELIVERY_ARTIFACT_UNAVAILABLE'])(
    'replaces an offer whose source changed (%s) with a fresh one of the current file',
    async (code) => {
      const { service, repository, offer, resolve, artifact } = makeService();
      const stale = record();
      const fresh = record({ id: 'fresh', state: 'offered' });
      offer.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
      const freshArtifact = artifact('fresh');
      resolve.mockRejectedValueOnce(new ConflictException({ code })).mockResolvedValueOnce(freshArtifact);

      const result = await service.prepareDownload(1, 2, 3, 'stale');

      expect(result).toEqual({ record: fresh, artifact: freshArtifact });
      expect(repository.retire).toHaveBeenCalledWith(1, 2, 'stale');
      expect(repository.reoffer).toHaveBeenCalledWith(1, 2, 3);
      expect(resolve).toHaveBeenLastCalledWith(1, 2, fresh);
    },
  );

  it('asks the device to sync when the fresh offer changes format instead of sending it under the old one', async () => {
    const { service, repository, offer, resolve } = makeService();
    offer.mockResolvedValueOnce(record()).mockResolvedValueOnce(record({ id: 'fresh', metadata: { ...record().metadata, format: 'epub' } }));
    resolve.mockRejectedValueOnce(new ConflictException({ code: 'DELIVERY_SOURCE_CHANGED' }));

    const error = await service.prepareDownload(1, 2, 3).catch((caught: unknown) => caught);

    expect(deliveryErrorCode(error)).toBe('KOBO_DELIVERY_FORMAT_CHANGED');
    expect(repository.reoffer).toHaveBeenCalledWith(1, 2, 3);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending replacement on its guided flow', async () => {
    const { service, repository, offer, resolve } = makeService();
    offer.mockResolvedValue(record({ options: { hyphenate: false, converterVersion: 'v1', replacement: true } }));
    resolve.mockRejectedValue(new ConflictException({ code: 'DELIVERY_SOURCE_CHANGED' }));

    await expect(service.prepareDownload(1, 2, 3)).rejects.toThrow(ConflictException);
    expect(repository.retire).not.toHaveBeenCalled();
  });

  it('does not replace a previous delivery standing in for a cancelled replacement', async () => {
    const { service, repository, offer, resolve } = makeService();
    offer.mockResolvedValue(record({ current: false }));
    resolve.mockRejectedValue(new ConflictException({ code: 'DELIVERY_SOURCE_CHANGED' }));

    await expect(service.prepareDownload(1, 2, 3)).rejects.toThrow(ConflictException);
    expect(repository.retire).not.toHaveBeenCalled();
  });

  it.each([new ForbiddenException({ code: 'DELIVERY_SOURCE_OUTSIDE_LIBRARY' }), new ConflictException({ code: 'DELIVERY_SOURCE_UNAVAILABLE' })])(
    'rethrows failures that a fresh offer cannot fix: %s',
    async (failure) => {
      const { service, repository, offer, resolve } = makeService();
      offer.mockResolvedValue(record());
      resolve.mockRejectedValue(failure);

      await expect(service.prepareDownload(1, 2, 3)).rejects.toBe(failure);
      expect(repository.retire).not.toHaveBeenCalled();
    },
  );

  it('rejects a delivery id that is no longer current without preparing any bytes', async () => {
    const { service, offer, resolve } = makeService();
    offer.mockResolvedValue(record({ id: 'fresh' }));

    await expect(service.prepareDownload(1, 2, 3, 'stale')).rejects.toThrow(NotFoundException);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('KoboDeliveryService.transferObserved', () => {
  it('points the device bookmark at a delivery it just downloaded', async () => {
    const { service, repository } = makeService();

    await service.transferObserved(1, 2, record({ id: 'fresh', state: 'offered' }));

    expect(repository.transition).toHaveBeenCalledWith(1, 2, 'fresh', ['offered', 'transfer_observed'], 'transfer_observed');
    expect(repository.adoptForDeviceReadingState).toHaveBeenCalledWith(1, 2, 3, 'fresh');
  });

  it('leaves the bookmark alone for a replacement or a delivery that is no longer transferable', async () => {
    const { service, repository } = makeService();

    await service.transferObserved(1, 2, record({ options: { hyphenate: false, converterVersion: 'v1', replacement: true } }));
    repository.transition.mockResolvedValueOnce([]);
    await service.transferObserved(1, 2, record({ state: 'cancelled' }));

    expect(repository.adoptForDeviceReadingState).not.toHaveBeenCalled();
  });
});
