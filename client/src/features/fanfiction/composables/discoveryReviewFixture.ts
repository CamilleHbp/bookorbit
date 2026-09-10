import type { FanfictionDiscoveryCandidate } from '@bookorbit/types'
export function discoveryReviewFixture() {
  const cutoff = '2026-09-10T12:00:00.000Z'
  const books: FanfictionDiscoveryCandidate[] = Array.from({ length: 26 }, (_, i) => ({
    id: String(i + 1),
    libraryId: 1,
    bookId: i + 1,
    bookFileId: i + 1,
    sha256: '',
    title: `Story ${i + 1}`,
    authors: ['Writer'],
    chapterCount: 10,
    urls: [
      {
        url: `https://${i < 23 ? 'royalroad.com' : 'archiveofourown.org'}/story/${i + 1}`,
        canonicalUrl: `https://${i < 23 ? 'royalroad.com' : 'archiveofourown.org'}/story/${i + 1}`,
        recognized: true,
        site: i < 23 ? 'royalroad.com' : 'archiveofourown.org',
      },
    ],
    state: 'pending',
    errorCode: null,
    sourceId: null,
    reviewJobId: null,
    version: 1,
    createdAt: cutoff,
    profileMatch: { profile: null },
  }))
  let operation: { website: string; ids?: string[]; excludedIds?: string[]; allMatching?: boolean } | null = null
  let uncertain = false
  const calls: { path: string; body: unknown }[] = []
  const site = (book: FanfictionDiscoveryCandidate) => (Number(book.id) <= 23 ? 'royalroad.com' : 'archiveofourown.org')
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'https://local')
    const path = url.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: `${path}${url.search}`, body })
    if (path.endsWith('/websites'))
      return respond({
        items: ['archiveofourown.org', 'royalroad.com']
          .filter((website) => !url.searchParams.has('website') || url.searchParams.get('website') === website)
          .map((website) => ({
            website,
            total: books.filter((book) => site(book) === website).length,
            remaining: books.filter((book) => site(book) === website && book.state === 'pending').length,
            linked: books.filter((book) => site(book) === website && book.state === 'linked').length,
          })),
        cutoff,
        nextCursor: null,
      })
    if (path.endsWith('/compare')) {
      const id = path.split('/').at(-2)!
      const book = books.find((item) => item.id === id)!
      return respond({
        canonicalUrl: body.canonicalUrl,
        title: id === '2' ? 'A different title' : book.title,
        authors: book.authors,
        chapterCount: 12,
        profile: null,
      })
    }
    if (path.endsWith('/selection')) {
      if (uncertain) return respond({ message: 'Connection lost' }, 503)
      operation = body
      return respond({ id: 'job', kind: 'adopt', state: 'queued', reviewWebsite: operation!.website })
    }
    if (path.endsWith('/jobs/job')) {
      const selected = books.filter(
        (book) =>
          book.state === 'pending' &&
          site(book) === operation!.website &&
          (operation!.allMatching || operation!.ids?.includes(book.id)) &&
          !operation!.excludedIds?.includes(book.id),
      )
      selected.forEach((book) => {
        book.state = 'linked'
      })
      return respond({
        id: 'job',
        kind: 'adopt',
        state: 'succeeded',
        reviewWebsite: operation!.website,
        result: { selection: { processed: selected.length, failed: 0, finished: true } },
      })
    }
    if (path.endsWith('/jobs')) return respond({ items: [] })
    if (path.endsWith('/discovery')) {
      const ids = url.searchParams.get('ids')?.split(',')
      const filtered = books.filter(
        (book) => site(book) === url.searchParams.get('website') && (ids ? ids.includes(book.id) : book.state === 'pending'),
      )
      const page = filtered
        .filter((book) => Number(book.id) > Number(url.searchParams.get('cursor') ?? 0))
        .slice(0, Number(url.searchParams.get('limit') ?? 20))
      return respond({
        items: page,
        total: filtered.length,
        nextCursor: filtered.some((book) => Number(book.id) > Number(page.at(-1)?.id ?? 0)) ? page.at(-1)!.id : null,
      })
    }
    throw new Error(`Unexpected request ${path}`)
  }
  return {
    books,
    calls,
    fetch,
    setUncertain: (value: boolean) => {
      uncertain = value
    },
  }
}
