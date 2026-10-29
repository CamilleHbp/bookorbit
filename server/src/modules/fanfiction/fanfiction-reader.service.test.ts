import { expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema';
import type { BookService } from '../book/book.service';
import type { RequestUser } from '../../common/types/request-user';
import { FanfictionReaderService } from './fanfiction-reader.service';
it('enforces book access before querying story information', async () => {
  const db = { select: vi.fn() };
  const books = { verifyFileAccess: vi.fn().mockRejectedValue(new ForbiddenException()) };
  const service = new FanfictionReaderService(db as unknown as NodePgDatabase<typeof schema>, books as unknown as BookService);
  await expect(service.forBook(1, 2, { id: 3 } as RequestUser)).rejects.toBeInstanceOf(ForbiddenException);
  expect(db.select).not.toHaveBeenCalled();
  books.verifyFileAccess.mockResolvedValue({ bookId: 9, libraryId: 1 });
  expect(await service.forBook(1, 2, { id: 3 } as RequestUser)).toBeNull();
  expect(db.select).not.toHaveBeenCalled();
});
