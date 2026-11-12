import { expect, it } from 'vitest'
import type { FanfictionDiscoveryCandidate } from '@bookorbit/types'
import { discoverySources } from './discoveryReview'

it('offers one recorded reading URL for each adapter identity', () => {
  const site = 'forum.questionablequesting.com'
  const base = 'https://' + site + '/threads/'
  const urls = ['before.11/', 'after.11/', 'different.12/'].map((path, i) => ({
    recognized: true as const,
    url: base + path,
    canonicalUrl: base + path,
    identityUrl: base + (i < 2 ? '11/' : '12/'),
    site,
  }))
  expect(discoverySources({ urls } as FanfictionDiscoveryCandidate)).toEqual([urls[1]!.canonicalUrl, urls[2]!.canonicalUrl])
})
