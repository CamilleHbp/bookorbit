import { bookFiles } from '../../db/schema';
import { and, isNotNull, or, sql, type SQLWrapper } from 'drizzle-orm';

export function staleGeneratedPosition(
  position: { converterVersion: SQLWrapper; extras: SQLWrapper },
  file: { currentRevisionId: SQLWrapper; sha256: SQLWrapper },
) {
  return and(
    isNotNull(position.converterVersion),
    or(
      sql`${position.extras}->>'revisionId' is distinct from ${file.currentRevisionId}::text`,
      sql`${position.extras}->>'sha256' is distinct from ${file.sha256}`,
    ),
  );
}

export function staleGeneratedPositionForFile(position: { converterVersion: SQLWrapper; extras: SQLWrapper; bookFileId: SQLWrapper }) {
  return and(
    isNotNull(position.converterVersion),
    sql`not exists (
      select 1 from ${bookFiles}
      where ${bookFiles.id} = ${position.bookFileId}
        and not (${staleGeneratedPosition(position, bookFiles)})
    )`,
  );
}
