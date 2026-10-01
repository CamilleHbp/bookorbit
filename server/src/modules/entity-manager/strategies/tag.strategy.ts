import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, exists, notExists, or, sql } from 'drizzle-orm';
import type { BrowseTagGroupsParams, BrowseTagGroupsResponse } from '@bookorbit/types';
import { buildEntityBookScopeClauses } from './entity-book-scope';
import type { EntityBookScope } from './entity-strategy.interface';
import { tagPrefixExpression } from './tag-grouping';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { books, bookTags, tags } from '../../../db/schema';
import { JunctionEntityStrategy } from './junction-entity.strategy';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class TagStrategy extends JunctionEntityStrategy {
  readonly entityType = 'tag' as const;
  protected readonly entityTable = tags;
  protected readonly junctionTable = bookTags;
  protected readonly entityIdCol = tags.id;
  protected readonly junctionEntityIdCol = bookTags.tagId;
  protected readonly junctionBookIdCol = bookTags.bookId;
  protected readonly nameCol = tags.name;
  protected readonly rawTableName = 'tags';
  protected readonly rawJunctionTable = 'book_tags';
  protected readonly rawEntityIdCol = 'tag_id';
  protected readonly hasCascade = true;

  constructor(@Inject(DB) db: Db) {
    super(db);
  }

  async browseGroups(scope: EntityBookScope, params: BrowseTagGroupsParams, usedOnly = false): Promise<BrowseTagGroupsResponse> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const prefix = tagPrefixExpression(tags.name, params.separator);
    const scopedBooks = this.db
      .select({ one: sql`1` })
      .from(bookTags)
      .innerJoin(books, eq(books.id, bookTags.bookId))
      .where(and(eq(bookTags.tagId, tags.id), ...buildEntityBookScopeClauses(this.db, scope)));
    const anyBooks = this.db
      .select({ one: sql`1` })
      .from(bookTags)
      .where(eq(bookTags.tagId, tags.id));
    const visible = usedOnly ? exists(scopedBooks) : or(exists(scopedBooks), notExists(anyBooks));
    const filter = and(visible, sql`${prefix} <> ''`, params.search ? sql`strpos(lower(${prefix}), lower(${params.search})) > 0` : undefined);
    const [items, totals] = await Promise.all([
      this.db
        .select({ prefix: prefix.as('prefix'), tagCount: sql<number>`count(*)::int` })
        .from(tags)
        .where(filter)
        .groupBy(sql`"prefix"`)
        .orderBy(asc(sql`"prefix"`))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ total: sql<number>`count(distinct ${prefix})::int` })
        .from(tags)
        .where(filter),
    ]);
    return { items, total: totals[0]?.total ?? 0, page, pageSize };
  }

  protected buildJunctionRow(bookId: number, entityId: number) {
    return { bookId, tagId: entityId };
  }
}
