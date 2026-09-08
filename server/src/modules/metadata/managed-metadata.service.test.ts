import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../../db/transaction';
import { ManagedMetadataService } from './managed-metadata.service';
import { MetadataService } from './metadata.service';
import { ManagedTagService } from './managed-tag.service';
import { BookMetadataLockService } from '../book-metadata-lock/book-metadata-lock.service';
import { bookMetadata } from '../../db/schema';

describe('confirmed story metadata', () => {
  it('applies only edited fields and locks them against subsequent automatic updates', async () => {
    let locked = ['publisher'];
    const locks = {
      getLockedFields: vi.fn(() => Promise.resolve(locked)),
      replaceLockedFields: vi.fn((_id, fields) => {
        locked = fields;
        return Promise.resolve();
      }),
      filterAutomatedBookUpdate: vi.fn((_id, dto) =>
        Promise.resolve({
          dto: Object.fromEntries(Object.entries(dto).filter(([key]) => !locked.includes(key))),
        }),
      ),
    };
    const metadata = { replaceAuthors: vi.fn() };
    const tags = { sync: vi.fn() };
    const writes: { table: unknown; values: Record<string, unknown> }[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ for: () => Promise.resolve([{ title: 'Original', description: 'Original summary' }]) }) }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          return { where: () => Promise.resolve([]) };
        },
      }),
    } as unknown as DatabaseTransaction;
    const module = await Test.createTestingModule({
      providers: [
        ManagedMetadataService,
        { provide: MetadataService, useValue: metadata },
        { provide: ManagedTagService, useValue: tags },
        { provide: BookMetadataLockService, useValue: locks },
      ],
    }).compile();
    const service = module.get(ManagedMetadataService);
    await service.applyImportEdits(tx, 10, { key: 'fanfiction:source', libraryId: 5 }, { title: 'My title', tags: [] });
    expect(writes.find((write) => write.table === bookMetadata)?.values).toMatchObject({ title: 'My title' });
    expect(writes.find((write) => write.table === bookMetadata)?.values).not.toHaveProperty('description');
    expect(metadata.replaceAuthors).not.toHaveBeenCalled();
    expect(tags.sync).toHaveBeenCalledWith(tx, 10, { key: 'fanfiction:source', libraryId: 5 }, []);
    expect(locked).toEqual(['publisher', 'title', 'tags']);
    writes.length = 0;
    tags.sync.mockClear();
    await service.apply(
      tx,
      10,
      { key: 'fanfiction:source', libraryId: 5 },
      { title: 'Remote title', tags: ['Remote tag'], description: 'New summary' },
    );
    expect(writes.find((write) => write.table === bookMetadata)?.values).toMatchObject({ description: 'New summary' });
    expect(writes.find((write) => write.table === bookMetadata)?.values).not.toHaveProperty('title');
    expect(tags.sync).not.toHaveBeenCalled();
    await module.close();
  });
});
