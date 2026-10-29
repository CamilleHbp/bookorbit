import { api } from '@/lib/api'
import type { BrowseTagsParams, BrowseEntitiesResponse, BrowseTagGroupsParams, BrowseTagGroupsResponse } from '@bookorbit/types'
function query(params: object): string {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString()
}
export async function browseTags(params: BrowseTagsParams): Promise<BrowseEntitiesResponse> {
  const response = await api(`/api/v1/tags?${query(params)}`)
  if (!response.ok) throw new Error('Could not load tags')
  return response.json()
}
export async function browseReaderTagGroups(params: BrowseTagGroupsParams): Promise<BrowseTagGroupsResponse> {
  const response = await api(`/api/v1/tags/groups?${query(params)}`)
  if (!response.ok) throw new Error('Could not load tag groups')
  return response.json()
}
