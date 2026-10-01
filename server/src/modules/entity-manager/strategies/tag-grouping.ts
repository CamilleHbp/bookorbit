import { sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

// Use literal string functions so custom separators never become regex or LIKE patterns.
export function tagPrefixExpression(name: PgColumn, separator: string) {
  return sql<string>`CASE WHEN strpos(${name}, ${separator}) > 1
    THEN split_part(${name}, ${separator}, 1) ELSE '' END`;
}
