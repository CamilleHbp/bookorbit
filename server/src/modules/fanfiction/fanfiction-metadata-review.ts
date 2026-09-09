import type { FanfictionMetadataField, FanfictionMetadataValues } from '@bookorbit/types';

export function changedStoryMetadata(current: FanfictionMetadataValues, incoming: FanfictionMetadataValues, previous?: FanfictionMetadataValues) {
  const fields: FanfictionMetadataField[] = ['title', 'description', 'authors', 'tags'];
  const value = (metadata: FanfictionMetadataValues, field: FanfictionMetadataField) =>
    field === 'tags'
      ? JSON.stringify([...new Set(metadata.tags.map((tag) => tag.trim().slice(0, 200)).filter(Boolean))].sort())
      : JSON.stringify(metadata[field]);
  return fields.filter(
    (field) => value(current, field) !== value(incoming, field) && (!previous || value(previous, field) !== value(incoming, field)),
  );
}
