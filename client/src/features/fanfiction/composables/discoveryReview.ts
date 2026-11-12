import type { FanfictionDiscoveryCandidate } from '@bookorbit/types'

export function discoverySources(item: FanfictionDiscoveryCandidate): string[] {
  const choices = item.urls.filter((url) => url.recognized)
  return [...new Map(choices.map((url) => [url.identityUrl ?? url.canonicalUrl, url.canonicalUrl])).values()]
}
