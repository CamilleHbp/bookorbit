import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { DB } from '../src/db';
import * as schema from '../src/db/schema';
import { TagStrategy } from '../src/modules/entity-manager/strategies/tag.strategy';

const url = process.env.TAG_GROUPS_TEST_DATABASE_URL;

describe.skipIf(!url)('tag groups against PostgreSQL', () => {
  let pool: Pool;
  let connection: PoolClient;
  let db: NodePgDatabase<typeof schema>;
  let strategy: TagStrategy;
  let libraryId: number;
  let otherLibraryId: number;
  let bookId: number;
  let otherBookId: number;
  let tagIds: Map<string, number>;

  beforeAll(async () => {
    if (!url || !/test/i.test(new URL(url).pathname)) throw new Error('Use a dedicated test database');
    pool = new Pool({ connectionString: url });
    connection = await pool.connect();
    db = drizzle(connection, { schema });
    const module = await Test.createTestingModule({ providers: [TagStrategy, { provide: DB, useValue: db }] }).compile();
    strategy = module.get(TagStrategy);
  });

  beforeEach(async () => {
    await connection.query('BEGIN');
    const libs = await db
      .insert(schema.libraries)
      .values([{ name: 'Visible test library' }, { name: 'Private test library' }])
      .returning();
    libraryId = libs[0]!.id;
    otherLibraryId = libs[1]!.id;
    const folders = await db
      .insert(schema.libraryFolders)
      .values([
        { libraryId, path: '/tag-test/visible' },
        { libraryId: otherLibraryId, path: '/tag-test/private' },
      ])
      .returning();
    const books = await db
      .insert(schema.books)
      .values([
        { libraryId, libraryFolderId: folders[0]!.id, folderPath: '/tag-test/visible/book' },
        { libraryId: otherLibraryId, libraryFolderId: folders[1]!.id, folderPath: '/tag-test/private/book' },
      ])
      .returning();
    bookId = books[0]!.id;
    otherBookId = books[1]!.id;
    const names = [
      'topic.fantasy',
      'topic.scifi.space',
      'tone.calm',
      'plain',
      '.leading',
      'archive.unused',
      'private.hidden',
      'topic.private',
      'source/ao3',
      'source/ffnet',
      'status-complete',
      'rating::teen',
      'literal%_value',
    ];
    const tags = await db
      .insert(schema.tags)
      .values(names.map((name) => ({ name })))
      .returning();
    tagIds = new Map(tags.map((tag) => [tag.name, tag.id]));
    await db.insert(schema.bookTags).values(
      names
        .filter((name) => name !== 'archive.unused')
        .map((name) => ({
          tagId: tagIds.get(name)!,
          bookId: name === 'private.hidden' || name === 'topic.private' ? otherBookId : bookId,
        })),
    );
  });

  afterEach(async () => {
    await connection.query('ROLLBACK');
  });
  afterAll(async () => {
    connection?.release();
    await pool?.end();
  });

  const browseParams = () => ({
    libraryIds: [libraryId],
    page: 1,
    pageSize: 25,
    sortBy: 'name' as const,
    sortOrder: 'asc' as const,
    bookCount: 'any' as const,
  });

  it('reader catalogs exclude unused tags and respect inaccessible libraries', async () => {
    const groups = await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.' }, true);
    expect(groups.items).toEqual([
      { prefix: 'tone', tagCount: 1 },
      { prefix: 'topic', tagCount: 2 },
    ]);
    const tags = await strategy.browse({ ...browseParams(), usedOnly: true });
    expect(tags.items.map((tag) => tag.name)).not.toContain('archive.unused');
    expect(tags.items.map((tag) => tag.name)).not.toContain('private.hidden');
    expect((await strategy.browse({ ...browseParams(), libraryIds: [], usedOnly: true })).total).toBe(0);
    expect((await strategy.browseGroups({ libraryIds: [] }, { separator: '.' }, true)).total).toBe(0);
  });

  it('groups all visible tags before pagination and excludes inaccessible tags', async () => {
    const first = await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.', pageSize: 2 });
    expect(first.total).toBe(3);
    expect(first.items).toEqual([
      { prefix: 'archive', tagCount: 1 },
      { prefix: 'tone', tagCount: 1 },
    ]);
    const second = await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.', pageSize: 2, page: 2 });
    expect(second.items).toEqual([{ prefix: 'topic', tagCount: 2 }]);
  });

  it.each([
    ['/', 'source', 2],
    ['-', 'status', 1],
    ['::', 'rating', 1],
    ['%_', 'literal', 1],
  ])('handles literal separator %s', async (separator, prefix, tagCount) => {
    const result = await strategy.browseGroups({ libraryIds: [libraryId] }, { separator });
    expect(result.items).toEqual([{ prefix, tagCount }]);
    const tags = await strategy.browse({ ...browseParams(), tagSeparator: separator, tagPrefix: prefix });
    expect(tags.total).toBe(tagCount);
  });

  it('filters the complete tag list by exact prefix and preserves nested names', async () => {
    const result = await strategy.browse({ ...browseParams(), tagSeparator: '.', tagPrefix: 'topic', pageSize: 1, page: 2 });
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.name)).toEqual(['topic.scifi.space']);
    expect((await strategy.browse({ ...browseParams(), tagSeparator: '.', tagPrefix: 'top' })).total).toBe(0);
  });

  it('treats leading separators as ungrouped and supports searching within a group', async () => {
    const ungrouped = await strategy.browse({ ...browseParams(), tagSeparator: '.', tagPrefix: '' });
    expect(ungrouped.items.map((item) => item.name)).toContain('.leading');
    expect(ungrouped.items.map((item) => item.name)).toContain('plain');
    expect(ungrouped.items.map((item) => item.name)).not.toContain('topic.fantasy');
    const filtered = await strategy.browse({ ...browseParams(), tagSeparator: '.', tagPrefix: 'topic', search: 'space' });
    expect(filtered.items.map((item) => item.name)).toEqual(['topic.scifi.space']);
  });

  it('never exposes used tags when no libraries are accessible', async () => {
    const result = await strategy.browseGroups({ libraryIds: [] }, { separator: '.' });
    expect(result.items).toEqual([{ prefix: 'archive', tagCount: 1 }]);
  });

  it('applies content restrictions to groups and their tag counts', async () => {
    const result = await strategy.browseGroups(
      { libraryIds: [libraryId], contentFilters: { ...EMPTY_CONTENT_FILTER_RULES, excludeTagIds: [tagIds.get('tone.calm')!] } },
      { separator: '.' },
    );
    expect(result.items).toEqual([{ prefix: 'archive', tagCount: 1 }]);
  });

  it('searches groups literally and returns a correct empty page total', async () => {
    expect((await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.', search: 'TOP' })).items).toEqual([
      { prefix: 'topic', tagCount: 2 },
    ]);
    expect((await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.', search: '%' })).total).toBe(0);
    expect(await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.', page: 99 })).toMatchObject({ items: [], total: 3 });
  });

  it('renames a tag globally, preserves its book link, and moves it to its new prefix', async () => {
    const id = tagIds.get('topic.fantasy')!;
    await strategy.rename({ entityId: id, newName: 'genre.fantasy', userId: 1, libraryIds: [libraryId] });
    const links = await db
      .select({ bookId: schema.bookTags.bookId, tagId: schema.bookTags.tagId })
      .from(schema.bookTags)
      .where(eq(schema.bookTags.tagId, id));
    expect(links).toEqual([{ bookId, tagId: id }]);
    expect((await strategy.browseGroups({ libraryIds: [libraryId] }, { separator: '.', search: 'genre' })).items).toEqual([
      { prefix: 'genre', tagCount: 1 },
    ]);
  });

  it('rejects edits to a tag used in another library', async () => {
    const id = tagIds.get('topic.private')!;
    await expect(strategy.rename({ entityId: id, newName: 'topic.stolen', userId: 1, libraryIds: [libraryId] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
