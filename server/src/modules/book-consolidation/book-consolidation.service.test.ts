import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { FanfictionLocationService } from '../fanfiction/fanfiction-location.service';
import { BookConsolidationRepository } from './book-consolidation.repository';
import { BookConsolidationService, type ConsolidationTx } from './book-consolidation.service';

describe('BookConsolidationService managed stories', () => {
  it('keeps a duplicate file when it has saved revisions or device state', async () => {
    const repository = new BookConsolidationRepository();
    const execute = vi.fn().mockResolvedValue({ rows: [{ present: true }] });
    await expect(repository.retireFileRow({ execute } as unknown as ConsolidationTx, 3, 4)).rejects.toBeInstanceOf(ConflictException);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a managed source before loading or changing its data', async () => {
    const repository = {
      lockBooks: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
      loadFacts: vi.fn(),
      deleteBook: vi.fn(),
    };
    const locations = {
      assertMergeSafe: vi.fn().mockRejectedValue(new ConflictException('Managed story')),
    };
    const module = await Test.createTestingModule({
      providers: [
        BookConsolidationService,
        { provide: BookConsolidationRepository, useValue: repository },
        { provide: FanfictionLocationService, useValue: locations },
      ],
    }).compile();
    const tx = {} as ConsolidationTx;
    try {
      await expect(
        module.get(BookConsolidationService).consolidate(tx, { targetBookId: 1, sourceBookId: 2, mergedByUserId: 7 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(locations.assertMergeSafe).toHaveBeenCalledWith(tx, 2);
      expect(repository.loadFacts).not.toHaveBeenCalled();
      expect(repository.deleteBook).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
