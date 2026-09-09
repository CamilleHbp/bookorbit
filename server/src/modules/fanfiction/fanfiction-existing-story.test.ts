import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, type ArgumentsHost } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from '../../common/filters/http-exception.filter';
import { DB } from '../../db';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionJobService } from './fanfiction-job.service';
import { LibraryService } from '../library/library.service';
import { UploadValidatorService } from '../upload/upload-validator.service';

describe('existing story import confirmation', () => {
  const user = { id: 7 } as RequestUser;
  const dto = { url: 'https://archiveofourown.org/works/123#chapter', folderId: 8, idempotencyKey: 'request' };
  const access = { administer: vi.fn() };
  const jobs = { importStory: vi.fn() };
  const libraries = { importDestination: vi.fn() };
  const validator = { validateFormat: vi.fn() };
  const query = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };
  const db = { select: vi.fn() };
  let service: FanfictionSourceService;
  beforeEach(async () => {
    vi.resetAllMocks();
    db.select.mockReturnValue(query);
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.limit.mockResolvedValue([]);
    libraries.importDestination.mockResolvedValue({ library: { allowedFormats: ['epub'] } });
    const module = await Test.createTestingModule({
      providers: [
        FanfictionSourceService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        { provide: FanfictionJobService, useValue: jobs },
        { provide: LibraryService, useValue: libraries },
        { provide: UploadValidatorService, useValue: validator },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = module.get(FanfictionSourceService);
  });
  it('returns the existing story without creating a job or changing its destination', async () => {
    query.limit.mockResolvedValue([{ id: 'existing', title: 'A story', bookFileId: 9 }]);
    const failure = await service.create(5, dto, user).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      errorCode: 'story_exists',
      errorMeta: { id: 'existing', title: 'A story' },
    });
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ url: '/sources', id: 'request' }) }) };
    new GlobalExceptionFilter().catch(failure, host as unknown as ArgumentsHost);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'story_exists', errorMeta: { id: 'existing', title: 'A story' } }));
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(jobs.importStory).not.toHaveBeenCalled();
    expect(libraries.importDestination).not.toHaveBeenCalled();
  });
  it('checks library administration before looking up a story', async () => {
    access.administer.mockRejectedValue(new ForbiddenException());
    await expect(service.create(5, dto, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });
  it('continues new and unfinished imports through the existing job service', async () => {
    jobs.importStory.mockResolvedValue({ id: 'job' });
    await expect(service.create(5, dto, user)).resolves.toEqual({ id: 'job' });
    query.limit.mockResolvedValue([{ id: 'pending', title: 'A story', bookFileId: null }]);
    await service.create(5, dto, user);
    expect(jobs.importStory).toHaveBeenCalledTimes(2);
    expect(jobs.importStory).toHaveBeenLastCalledWith(5, dto, user);
  });
});
