import type { FanfictionDiscoveryCandidate } from '@bookorbit/types'

export function discoverySources(item: FanfictionDiscoveryCandidate): string[] {
  return [...new Set(item.urls.flatMap((url) => (url.recognized ? [url.canonicalUrl] : [])))]
}
