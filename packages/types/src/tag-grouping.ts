export interface TagGroupingPreferences {
  enabled: boolean;
  separator: string;
}

export const DEFAULT_TAG_GROUPING: TagGroupingPreferences = { enabled: true, separator: "." };
export const MAX_TAG_SEPARATOR_LENGTH = 8;

export interface BrowseTagGroupsParams {
  separator: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface TagPrefixGroup {
  prefix: string;
  tagCount: number;
}

export interface BrowseTagGroupsResponse {
  items: TagPrefixGroup[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BrowseTagsParams {
  search?: string;
  tagSeparator?: string;
  tagPrefix?: string;
  page?: number;
  pageSize?: number;
}
