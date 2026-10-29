import { RevisionCoordinationService } from './revision-coordination.service';
import { Test } from '@nestjs/testing';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { BookRevisionService } from './book-revision.service';
import { EpubManifestService } from './epub-manifest.service';
import { inspectStableFile, waitForStableFile } from './file-inspection';

vi.mock('./file-inspection', async (original) => ({
  ...(await original<typeof import('./file-inspection')>()),
  inspectStableFile: vi.fn(),
  waitForStableFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));

function query(result: unknown) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const fn of [chain.from, chain.where, chain.limit, chain.for]) fn.mockReturnValue(chain);
  return chain;
}

const signature = { dev: 1n, ino: 2n, size: 100n, mtimeNs: 10n, ctimeNs: 20n };
const fresh = { signature, ino: 2n, sizeBytes: 100, mtime: new Date(1), sha256: 'b'.repeat(64), fileHash: 'b'.repeat(32) };
const current = {
  id: 1,
  bookId: 2,
  libraryFolderId: 3,
  absolutePath: '/library/book.epub',
  updatedAt: new Date(0),
  currentRevisionId: 'old',
  sha256: 'a'.repeat(64),
  fileHash: 'a'.repeat(32),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(waitForStableFile).mockResolvedValue('stable');
  vi.mocked(inspectStableFile).mockResolvedValue({ status: 'stable', file: fresh });
  vi.mocked(stat).mockResolvedValue(signature as Awaited<ReturnType<typeof stat>>);
});

async function setup(locked = current) {
  const saved = { ...current, ...fresh, currentRevisionId: 'new' };
  const values = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'new' }]), onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }));
  const set = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([saved]) })) }));
  const tx = {
    select: vi.fn((fields?: unknown) => query(fields ? [] : [locked])),
    insert: vi.fn(() => ({ values })),
    update: vi.fn(() => ({ set })),
  };
  const db = { select: vi.fn(() => query([current])), transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)) };
  const module = await Test.createTestingModule({
    providers: [
      { provide: RevisionCoordinationService, useValue: { lockFile: vi.fn() } },
      BookRevisionService,
      { provide: DB, useValue: db },
      { provide: EpubManifestService, useValue: { inspect: vi.fn() } },
    ],
  }).compile();
  return { service: module.get(BookRevisionService), db, tx, values, set };
}

describe('revision observation', () => {
  it('bounds concurrent inspection and releases capacity after completion', async () => {
    const releases: Array<(value: 'stable') => void> = [];
    vi.mocked(waitForStableFile).mockImplementation(() => new Promise<'stable'>((resolve) => releases.push(resolve)));
    const { service } = await setup();
    const first = service.observeFile(1, {});
    const second = service.observeFile(1, {});
    await expect(service.observeFile(1, {})).rejects.toThrow('inspection is busy');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach((resolve) => resolve('stable'));
    await Promise.all([first, second]);
    vi.mocked(waitForStableFile).mockResolvedValue('stable');
    await expect(service.observeFile(1, {})).resolves.toMatchObject({ id: 1 });
  });
  it('records the old fingerprint and the revision in the same transaction as the current hash', async () => {
    const { service, tx, values, set } = await setup();
    await service.observeFile(1, { sizeBytes: 80 });
    expect(tx.insert).toHaveBeenNthCalledWith(1, schema.bookFileRevisions);
    expect(tx.insert).toHaveBeenNthCalledWith(2, schema.bookFileHashHistory);
    expect(values).toHaveBeenCalledWith({ bookFileId: 1, fileHash: current.fileHash, reason: 'external_change' });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: 100, sha256: fresh.sha256, fileHash: fresh.fileHash, currentRevisionId: 'new' }),
    );
    expect(values.mock.invocationCallOrder[1]).toBeLessThan(set.mock.invocationCallOrder[0]);
  });

  it('does not create a revision for unchanged bytes', async () => {
    vi.mocked(inspectStableFile).mockResolvedValue({ status: 'stable', file: { ...fresh, sha256: current.sha256, fileHash: current.fileHash } });
    const { service, tx, set } = await setup();
    await service.observeFile(1, { mtime: new Date(2) });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ currentRevisionId: 'old' }));
  });

  it('records a new revision even when partial MD5 remains equal', async () => {
    vi.mocked(inspectStableFile).mockResolvedValue({ status: 'stable', file: { ...fresh, fileHash: current.fileHash } });
    const { service, tx } = await setup();
    await service.observeFile(1, {});
    expect(tx.insert).toHaveBeenCalledExactlyOnceWith(schema.bookFileRevisions);
  });

  it('does not adopt bytes belonging to an incomplete publication', async () => {
    const { service, tx } = await setup();
    tx.select.mockImplementation((fields?: unknown) => query(fields ? [{ id: 'pending' }] : [current]));
    await expect(service.observeFile(1, {})).rejects.toThrow('finish recovery');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('preserves database state when inspection fails', async () => {
    vi.mocked(inspectStableFile).mockResolvedValue({ status: 'retryable', reason: 'changed' });
    const { service, db } = await setup();
    await expect(service.observeFile(1, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects concurrent database and filesystem changes before publishing identity', async () => {
    const { service, tx } = await setup({ ...current, updatedAt: new Date(9) });
    await expect(service.observeFile(1, {})).rejects.toBeInstanceOf(ConflictException);
    expect(tx.insert).not.toHaveBeenCalled();
    const next = await setup();
    vi.mocked(stat).mockResolvedValue({ ...signature, ino: 99n } as Awaited<ReturnType<typeof stat>>);
    await expect(next.service.observeFile(1, {})).rejects.toBeInstanceOf(ConflictException);
    expect(next.tx.insert).not.toHaveBeenCalled();
  });
});
