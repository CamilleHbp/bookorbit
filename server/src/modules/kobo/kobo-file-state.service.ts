import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../db/transaction';
import * as schema from '../../db/schema';

@Injectable()
export class KoboFileStateService {
  async preserveMetadataOnlyCopy(tx: DatabaseTransaction, bookId: number, bookFileId: number, previousHash: string | null, nextHash: string) {
    if (previousHash === nextHash) return;
    // Kobo keeps its installed bytes during metadata updates. Advancing only snapshots
    // that knew the old hash avoids a NewEntitlement that would discard annotations.
    await tx.execute(sql`
      UPDATE ${schema.koboSnapshotBooks} AS snapshot
      SET file_hash = ${nextHash}
      FROM ${schema.books} AS book
      WHERE book.id = ${bookId}
        AND book.primary_file_id = ${bookFileId}
        AND snapshot.book_id = book.id
        AND snapshot.pending_delete = false
        AND snapshot.removed_by_device = false
        AND snapshot.file_hash IS NOT DISTINCT FROM ${previousHash}
    `);
  }
}
