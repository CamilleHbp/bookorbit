import type { FanfictionDiscoveryCandidate } from '@bookorbit/types'

export function discoverySources(item: FanfictionDiscoveryCandidate): string[] {
  return [...new Set(item.urls.flatMap((url) => (url.recognized ? [url.canonicalUrl] : [])))]
}

export function isConfidentDiscoveryMatch(item: FanfictionDiscoveryCandidate): boolean {
  return item.state === 'pending' && discoverySources(item).length === 1 && Boolean(item.profileMatch) && !item.profileMatch?.ambiguous
}

export function discoveryWebsite(item: FanfictionDiscoveryCandidate): string {
  const sites = new Set<string>()
  for (const url of discoverySources(item)) {
    try {
      sites.add(new URL(url).hostname.replace(/^www\./, ''))
    } catch {
      return ''
    }
  }
  return sites.size === 1 ? [...sites][0]! : ''
}

export function groupDiscoveryByWebsite(items: FanfictionDiscoveryCandidate[]) {
  const groups = new Map<string, FanfictionDiscoveryCandidate[]>()
  for (const item of items) {
    const website = discoveryWebsite(item)
    const group = groups.get(website) ?? []
    group.push(item)
    groups.set(website, group)
  }
  return [...groups].sort(([a], [b]) => (a && b ? a.localeCompare(b) : a ? -1 : 1)).map(([website, books]) => ({ website, books }))
}

export function isDiscoveryReady(item: FanfictionDiscoveryCandidate, profile = 'auto', source?: string): boolean {
  const sources = discoverySources(item)
  if (!(source ? sources.includes(source) : sources.length === 1)) return false
  return profile !== 'auto' || (sources.length === 1 && Boolean(item.profileMatch) && !item.profileMatch?.ambiguous)
}
