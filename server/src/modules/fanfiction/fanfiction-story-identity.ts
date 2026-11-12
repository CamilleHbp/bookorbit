import { ConflictException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, notLike } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import type { FanfictionRecognizedUrl } from '@bookorbit/types';
import * as schema from '../../db/schema';
import type { FanficfareRuntimeService } from './fanficfare-runtime.service';

type Recognized = Extract<FanfictionRecognizedUrl, { recognized: true }>;
export const storyIdentity = (story: Recognized) => story.identityUrl ?? story.canonicalUrl;

export async function sameStory(runtime: FanficfareRuntimeService, left: string, right: string, signal?: AbortSignal) {
  if (left === right) return true;
  const [a, b] = await runtime.recognize([left, right], signal);
  return !!a?.recognized && !!b?.recognized && storyIdentity(a) === storyIdentity(b);
}

export async function recordedStories(runtime: FanficfareRuntimeService, choices: FanfictionRecognizedUrl[]) {
  const recognized = choices.filter((url) => url.recognized);
  const urls = [...new Set(recognized.map((url) => url.canonicalUrl))];
  if (urls.length < 2) return recognized;
  // Preserve the recorded URLs users were offered, including legacy records.
  const normalized = new Map((await runtime.recognize(urls)).filter((url) => url.recognized).map((url) => [url.url, storyIdentity(url)]));
  return recognized.map((url) => ({ ...url, identityUrl: normalized.get(url.canonicalUrl) ?? storyIdentity(url) }));
}

export async function reservationKey(
  db: Pick<NodePgDatabase<typeof schema>, 'select'>,
  runtime: FanficfareRuntimeService,
  libraryId: number,
  url: string,
) {
  const [recognized] = await runtime.recognize([url]);
  const identity = recognized?.recognized ? storyIdentity(recognized) : url;
  const key = 'v2:' + createHash('sha256').update(identity).digest('base64url');
  const sources = schema.fanfictionSources;
  const exactLegacyKey = createHash('sha256').update(url).digest('hex');
  const [current] = await db
    .select({ key: sources.canonicalKey })
    .from(sources)
    .where(and(eq(sources.libraryId, libraryId), inArray(sources.canonicalKey, [key, exactLegacyKey])))
    .limit(1);
  if (current) return current.key;

  // Older reservations hashed the full reading URL. Keep their row and file IDs,
  // including unlinked records, so a retry cannot create a second copy.
  const site = new URL(recognized?.recognized ? recognized.canonicalUrl : url).hostname.replace(/^www\./, '');
  let cursor: string | undefined;
  let match: string | undefined;
  for (;;) {
    const rows = await db
      .select({ id: sources.id, url: sources.canonicalUrl, key: sources.canonicalKey })
      .from(sources)
      .where(
        and(
          eq(sources.libraryId, libraryId),
          eq(sources.site, site),
          notLike(sources.canonicalKey, 'v2:%'),
          cursor ? gt(sources.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(sources.id))
      .limit(100);
    if (!rows.length) break;
    const identities = await runtime.recognize(rows.map((row) => row.url));
    for (const [i, row] of rows.entries()) {
      const candidate = identities[i];
      if (row.url !== url && (!candidate?.recognized || storyIdentity(candidate) !== identity)) continue;
      if (match) throw new ConflictException('Multiple saved sources identify this story');
      match = row.key;
    }
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].id;
  }
  return match ?? key;
}
