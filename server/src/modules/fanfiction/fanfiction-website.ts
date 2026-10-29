import type { FanficfareSite, FanfictionWebsite } from '@bookorbit/types';

const websites: Record<string, { name: string; access: FanfictionWebsite['access'] }> = {
  'archiveofourown.org': { name: 'Archive of Our Own', access: 'login' },
  'storiesonline.net': { name: 'StoriesOnline', access: 'login' },
  'fiction.live': { name: 'Fiction.live', access: 'cookies' },
  'www.royalroad.com': { name: 'Royal Road', access: 'cookies' },
  'forums.spacebattles.com': { name: 'SpaceBattles', access: 'login' },
  'forums.sufficientvelocity.com': { name: 'Sufficient Velocity', access: 'login' },
  'forum.questionablequesting.com': { name: 'Questionable Questing', access: 'login' },
  'www.fanfiction.net': { name: 'FanFiction.net', access: 'cookies' },
  'www.fictionpress.com': { name: 'FictionPress', access: 'cookies' },
};

export function fanfictionWebsite(site: FanficfareSite): FanfictionWebsite {
  return { ...site, id: site.id.replace(/^www\./, ''), ...(websites[site.id] ?? { name: site.id, access: 'cookies' }) };
}

export const connectionAccessErrors = ['authentication_required', 'access_denied'] as const;

export function isConnectionAccessError(code: string | null | undefined): boolean {
  return connectionAccessErrors.some((value) => value === code);
}
