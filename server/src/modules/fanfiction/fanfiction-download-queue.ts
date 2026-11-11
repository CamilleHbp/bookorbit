import type { FanfictionDownloadQueue, FanfictionDownloadRow } from '@bookorbit/types';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../db/schema';
import type { FanfictionDownloadsDto } from './dto/fanfiction-job.dto';

export function actionableDownloadJob(alias: 'j' | 'newer') {
  const job = sql.identifier(alias);
  return sql`(${job}.result->>'existingImportId' is null and not (
    ${job}.kind='import' and ${job}.state='succeeded' and ${job}.source_id is null
    and ${job}.result->>'sourceId' is not null and ${job}.result->>'bookId' is null))`;
}

function downloadEntries(libraryId: number, userId: number) {
  return sql`with latest as (
      select distinct on (j.url) j.id
      from ${schema.fanfictionJobs} j
      where j.library_id=${libraryId} and j.user_id=${userId} and j.kind in ('import','update','refresh')
        and ${actionableDownloadJob('j')}
      order by j.url, (j.state='running') desc, (j.state='queued') desc, j.created_at desc, j.id desc
    ), pending as (
      select distinct on (coalesce(j.source_id::text, j.url))
        j.id as job_id, j.source_id, coalesce(s.book_id,(j.result->>'bookId')::int) as book_id, j.site, coalesce(nullif(j.result#>>'{importReview,values,title}',''), s.title, j.result#>>'{preview,title}', j.url) as title,
        j.kind, j.state, j.error_code as code, j.updated_at, s.chapter_count as current_chapters,
        (j.result#>>'{preview,chapterCount}')::int as proposed_chapters,
        j.result->'progress' as progress, j.result->'changes' as changes,
        case when j.state='queued' and j.error_code is not null and j.attempts>0 then j.run_after end as retry_at
      from latest l join ${schema.fanfictionJobs} j on j.id=l.id left join ${schema.fanfictionSources} s on s.id=j.source_id and s.library_id=j.library_id
      where j.library_id=${libraryId} and j.user_id=${userId} and j.kind in ('import','update','refresh')
        and (j.state in ('queued','running','review_required','failed','configuration_blocked') or
          (j.state='cancelled' and j.result#>>'{importReview,approved}'='true' and s.book_id is null))
        and (s.id is null or s.state <> 'unlinked')
        and (j.state in ('queued','running','cancelled') or s.id is null or (j.kind='import' and s.book_id is null) or s.attention_code=j.error_code or (s.metadata_review_pending and j.error_code='metadata_review_required'))

      order by coalesce(j.source_id::text,j.url), (j.state='running') desc,(j.state='queued') desc,j.created_at desc,j.id desc
    ), entries as (
      select * from pending
      union all
      select null,s.id,s.book_id,s.site,s.title,null,s.state,coalesce(s.attention_code,'metadata_review_required'),s.updated_at,s.chapter_count,null,null,null,null
      from ${schema.fanfictionSources} s where s.library_id=${libraryId} and coalesce(s.maintainer_user_id,s.created_by)=${userId}
        and (s.attention_code is not null or s.metadata_review_pending) and s.state<>'unlinked' and not exists (select 1 from pending p where p.source_id=s.id)
    ), classified as (
      select *, case when state='running' then 'running' when retry_at is not null then 'retrying' when state='queued' then 'queued' else 'attention' end as section,
        case when code in ('source_failed','source_unavailable','source_rate_limited','download_timeout') then 'website'
          when code in ('authentication_required','access_denied') then 'login'
          when code in ('content_review_required','source_chapter_reduction') then 'chapter'
          when code in ('source_not_found','unsupported_story_url') then 'story' when state='cancelled' then 'stopped'
          when code='metadata_review_required' then 'metadata' when code='import_review_required' then 'import'
          when state not in ('running','queued') or code is not null then 'unknown' end as issue
      from entries
    ), keyed as (
      select *, case when section in ('retrying','attention') and issue in ('website','login','story','unknown')
        and state not in ('review_required','cancelled') and code is not null
        then md5(concat_ws('|',section,site,code)) end as group_key
      from classified
    )`;
}

export type RetryScope = { group: string } | { site: string; settingsChanged?: boolean };

export function retryGroupMembers(
  db: NodePgDatabase<typeof schema>,
  libraryId: number,
  userId: number,
  scope: RetryScope,
  cutoff: string,
  cursor: string | null,
) {
  return db.execute<{ id: string; job_id: string | null; source_id: string | null; code: string; state: string }>(sql`
    ${downloadEntries(libraryId, userId)}
    select coalesce(job_id,source_id) as id, job_id, source_id, code, state from keyed
    where group_key is not null and ${'group' in scope ? sql`group_key=${scope.group}` : sql`site=${scope.site}`} and updated_at <= ${cutoff}::timestamptz
      and ${
        'site' in scope && scope.settingsChanged
          ? sql`code in ('access_denied','authentication_required','configuration_blocked') and not exists (
        select 1 from ${schema.fanfictionSources} s where s.id=keyed.source_id and s.library_id=${libraryId}
          and s.book_file_id is not null and (not s.updates_enabled or s.metadata_review_pending))`
          : sql`true`
      }
      and ${cursor ? sql`coalesce(job_id,source_id) > ${cursor}::uuid` : sql`true`}
    order by coalesce(job_id,source_id) limit 50
  `);
}

export async function downloadQueue(db: NodePgDatabase<typeof schema>, libraryId: number, userId: number, dto: FanfictionDownloadsDto) {
  // Jobs own active transfers. Source attention also covers library data created before durable jobs.
  const result = await db.execute<{ item: FanfictionDownloadRow; total: number }>(sql`
    ${downloadEntries(libraryId, userId)}, grouped as (
      select *, count(*) over grp as members, min(retry_at) over grp as first_retry,
        row_number() over (partition by coalesce(group_key,job_id::text,source_id::text) order by updated_at desc, coalesce(job_id,source_id)) as representative
      from keyed
      where ${dto.section ? sql`section=${dto.section}` : sql`true`}
        and ${dto.group ? sql`group_key=${dto.group}` : sql`true`}
      window grp as (partition by coalesce(group_key,job_id::text,source_id::text))
    ), ranked as (
      select *, count(*) over (partition by section)::int as total,
        row_number() over (partition by section order by (group_key is not null) desc, members desc, updated_at desc, coalesce(job_id,source_id)) as position
      from grouped where ${dto.group ? sql`true` : sql`representative=1`}
    )
    select jsonb_build_object(
      'id', ${dto.group ? sql`coalesce(job_id,source_id)::text` : sql`coalesce(group_key,job_id::text,source_id::text)`},
      'section',section,'issue',issue,'groupKey',${dto.group ? sql`null::text` : sql`group_key`},'count',${dto.group ? sql`1` : sql`members`},
      'site',site,'title',title,'kind',kind,'jobId',job_id,'sourceId',source_id,'bookId',book_id,'code',code,
      'nextAttemptAt',${dto.group ? sql`retry_at` : sql`first_retry`},'progress',progress,
      'removed',coalesce((changes->>'removed')::int,0),'changed',coalesce((changes->>'changed')::int,0),
      'reordered',coalesce((changes->>'reordered')::boolean,false),'currentChapters',current_chapters,'proposedChapters',proposed_chapters
    ) as item,total from ranked
    where position between least(${dto.offset}, ((total-1)/20)*20)+1 and least(${dto.offset}, ((total-1)/20)*20)+20
    order by section,position
  `);
  const totals: FanfictionDownloadQueue['totals'] = { running: 0, queued: 0, retrying: 0, attention: 0 };
  for (const { item, total } of result.rows) totals[item.section] = total;
  return { items: result.rows.map((row) => row.item), totals };
}
