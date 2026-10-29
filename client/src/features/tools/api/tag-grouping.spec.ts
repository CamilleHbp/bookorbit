import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browseEntities, browseTagGroups, saveTagGrouping } from './entity-manager'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof api>() }))
const request = vi.mocked(api)
describe('tag grouping API', () => {
  beforeEach(() => {
    request.mockResolvedValue(new Response(JSON.stringify({ items: [], total: 0 })))
  })
  it('encodes separators and keeps the empty prefix used for ungrouped tags', async () => {
    await browseEntities('tag', { tagSeparator: '%_', tagPrefix: '', page: 2 })
    expect(request).toHaveBeenLastCalledWith('/api/v1/entity-manager/tag/browse?page=2&tagSeparator=%25_&tagPrefix=')
  })
  it('uses the bounded tag group endpoint', async () => {
    await browseTagGroups({ separator: '/', search: 'fandom', page: 2, pageSize: 20 })
    expect(request).toHaveBeenLastCalledWith('/api/v1/entity-manager/tag/groups?separator=%2F&search=fandom&page=2&pageSize=20')
  })
  it('sends a typed preference to the current user endpoint', async () => {
    await saveTagGrouping({ enabled: true, separator: '::' })
    expect(request).toHaveBeenLastCalledWith(
      '/api/v1/users/me/tag-grouping',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: true, separator: '::' }) }),
    )
  })
  it('propagates a preference failure', async () => {
    request.mockResolvedValueOnce(new Response('{}', { status: 403 }))
    await expect(saveTagGrouping({ enabled: false, separator: '.' })).rejects.toThrow('Could not save tag grouping')
  })
})
