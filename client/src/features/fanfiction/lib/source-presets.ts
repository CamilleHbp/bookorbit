export const sourcePresets = [
  {
    id: 'fictionlive',
    name: 'Fiction.live',
    section: 'fiction.live',
    hosts: ['fiction.live', 'beta.fiction.live'],
    url: 'https://fiction.live',
    login: false,
    configuration: '[fiction.live]\ndedup_img_files: true\ninclude_appendices: true\nlegend_spoilers: true\n',
  },
  {
    id: 'ao3',
    name: 'Archive of Our Own',
    section: 'archiveofourown.org',
    hosts: ['archiveofourown.org', 'www.archiveofourown.org'],
    url: 'https://archiveofourown.org',
    login: true,
    configuration: '[archiveofourown.org]\n',
  },
  {
    id: 'royalroad',
    name: 'Royal Road',
    section: 'www.royalroad.com',
    hosts: ['royalroad.com', 'www.royalroad.com'],
    url: 'https://www.royalroad.com',
    login: false,
    configuration: '[www.royalroad.com]\n',
  },
  {
    id: 'spacebattles',
    name: 'SpaceBattles',
    section: 'forums.spacebattles.com',
    hosts: ['forums.spacebattles.com'],
    url: 'https://forums.spacebattles.com',
    login: true,
    configuration: '[forums.spacebattles.com]\n',
  },
  {
    id: 'sufficientvelocity',
    name: 'Sufficient Velocity',
    section: 'forums.sufficientvelocity.com',
    hosts: ['forums.sufficientvelocity.com'],
    url: 'https://forums.sufficientvelocity.com',
    login: true,
    configuration: '[forums.sufficientvelocity.com]\n',
  },
  {
    id: 'questionablequesting',
    name: 'Questionable Questing',
    section: 'forum.questionablequesting.com',
    hosts: ['forum.questionablequesting.com'],
    url: 'https://forum.questionablequesting.com',
    login: true,
    configuration: '[forum.questionablequesting.com]\n',
  },
  {
    id: 'fanfiction',
    name: 'FanFiction.net',
    section: 'www.fanfiction.net',
    hosts: ['fanfiction.net', 'www.fanfiction.net', 'm.fanfiction.net'],
    url: 'https://www.fanfiction.net',
    login: false,
    configuration: '[www.fanfiction.net]\n',
  },
  {
    id: 'fictionpress',
    name: 'FictionPress',
    section: 'www.fictionpress.com',
    hosts: ['fictionpress.com', 'www.fictionpress.com'],
    url: 'https://www.fictionpress.com',
    login: false,
    configuration: '[www.fictionpress.com]\n',
  },
] as const

export function sourcePresetForUrl(value: string) {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:') return undefined
    return sourcePresets.find((preset) => preset.hosts.some((host) => host === url.hostname))
  } catch {
    return undefined
  }
}
