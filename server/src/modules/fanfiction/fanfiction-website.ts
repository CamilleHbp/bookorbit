import type { FanficfareSite, FanfictionWebsite } from '@bookorbit/types';

const websiteNames: Record<string, string> = {
  'archiveofourown.org': 'Archive of Our Own',
  'www.scribblehub.com': 'ScribbleHub',
  'storiesonline.net': 'StoriesOnline',
  'fiction.live': 'Fiction.live',
  'www.royalroad.com': 'Royal Road',
  'forums.spacebattles.com': 'SpaceBattles',
  'forums.sufficientvelocity.com': 'Sufficient Velocity',
  'forum.questionablequesting.com': 'Questionable Questing',
  'www.fanfiction.net': 'FanFiction.net',
  'www.fictionpress.com': 'FictionPress',
};

export function fanfictionWebsite(site: FanficfareSite): FanfictionWebsite {
  return {
    id: site.id.replace(/^www\./, ''),
    examples: site.examples,
    name: websiteNames[site.id] ?? site.id,
    access: site.supportsPasswordLogin ? 'login' : 'cookies',
    ...(['www.royalroad.com', 'www.fanfiction.net'].includes(site.id) && site.supportsPasswordLogin ? { usernameKind: 'email' as const } : {}),
  };
}

export const connectionAccessErrors = ['authentication_required', 'access_denied'] as const;

export function isConnectionAccessError(code: string | null | undefined): boolean {
  return connectionAccessErrors.some((value) => value === code);
}
