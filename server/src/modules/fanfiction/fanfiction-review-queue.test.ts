import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../../db/db.module';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionSourceService } from './fanfiction-source.service';
import { FanfictionAccessService } from './fanfiction-access.service';
import { FanfictionReaderService } from './fanfiction-reader.service';
import { ListFanfictionSourcesDto } from './dto/fanfiction-source.dto';

describe('fanfiction review queue scope', () => {
  const user = { id: 7 } as RequestUser;
  const access = { administer: vi.fn() };
  const reader = { project: vi.fn().mockResolvedValue([]) };
  const query = { from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() };
  const db = { select: vi.fn() };
  let service: FanfictionSourceService;
  beforeEach(async () => {
    vi.clearAllMocks();
    access.administer.mockResolvedValue(undefined);
    db.select.mockReturnValue(query);
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    query.limit.mockResolvedValue([]);
    const module = await Test.createTestingModule({
      providers: [
        FanfictionSourceService,
        { provide: DB, useValue: db },
        { provide: FanfictionAccessService, useValue: access },
        { provide: FanfictionReaderService, useValue: reader },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = module.get(FanfictionSourceService);
  });
  it.each(['pending', 'all'] as const)('bounds %s reviews to installed stories in the authorized library', async (reviewScope) => {
    const result = await service.list(5, Object.assign(new ListFanfictionSourcesDto(), { reviewScope, limit: 25 }), user);
    expect(access.administer).toHaveBeenCalledWith(user, 5);
    const compiled = new PgDialect().sqlToQuery(query.where.mock.calls[0]![0] as SQL);
    expect(compiled.sql).toContain('"library_id" = $1');
    expect(compiled.params[0]).toBe(5);
    expect(compiled.sql).toContain('"book_id" is not null');
    expect(compiled.sql).toContain("<> 'unlinked'");
    expect(compiled.sql.includes('"metadata_review_pending"')).toBe(reviewScope === 'pending');
    expect(query.limit).toHaveBeenCalledWith(26);
    expect(reader.project).toHaveBeenCalledWith([], user.id);
    expect(result).toEqual({ items: [], nextCursor: null });
  });
  it('does not query stories when library administration is denied', async () => {
    access.administer.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.list(5, Object.assign(new ListFanfictionSourcesDto(), { reviewScope: 'pending' }), user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.select).not.toHaveBeenCalled();
  });
});
