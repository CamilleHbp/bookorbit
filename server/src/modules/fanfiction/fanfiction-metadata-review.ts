import type { FanfictionMetadataField, FanfictionMetadataValues } from '@bookorbit/types';

export const storyTags = (tags: string[]) => [...new Set(tags.map((tag) => tag.trim().slice(0, 200)).filter(Boolean))].sort();

export function planStoryMetadata(
  current: FanfictionMetadataValues,
  incoming: FanfictionMetadataValues,
  managed: string[],
  locked: string[],
  previous?: FanfictionMetadataValues,
) {
  const fields: FanfictionMetadataField[] = [];
  const values = { ...current, tags: managed };
  for (const field of ['title', 'description', 'authors'] as const) {
    if (
      locked.includes(field) ||
      JSON.stringify(current[field]) === JSON.stringify(incoming[field]) ||
      (previous && JSON.stringify(previous[field]) === JSON.stringify(incoming[field]))
    )
      continue;
    if (previous && JSON.stringify(current[field]) === JSON.stringify(previous[field])) Object.assign(values, { [field]: incoming[field] });
    else fields.push(field);
  }
  const baseline = storyTags(previous?.tags ?? managed);
  const remote = storyTags(incoming.tags);
  if (!locked.includes('tags') && JSON.stringify(baseline) !== JSON.stringify(remote)) fields.push('tags');
  return { fields, values };
}

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
