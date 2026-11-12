import type { FanfictionDownloadRow } from '@bookorbit/types'

export function safeVerificationUrl(row: FanfictionDownloadRow): string | null {
  if (!['fanfiction_net_browser_verification', 'source_browser_verification'].includes(row.code ?? '') || !row.verificationUrl) return null
  const site = row.site.replace(/^www\./, '')
  if (site === 'archiveofourown.org') return null
  try {
    const url = new URL(row.verificationUrl)
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && url.hostname.replace(/^www\./, '') === site ? url.href : null
  } catch {
    return null
  }
}
