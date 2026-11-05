import type { IncomingLabel, LabelTarget, LabelRule, LabelResolution } from '@bookorbit/types';
export type { IncomingLabel, LabelTarget, LabelRule, LabelResolution } from '@bookorbit/types';
import { labelKey } from '../../common/utils/label-key';
export { labelKey } from '../../common/utils/label-key';
const broadRelationships = new Set(['m/m', 'f/f', 'f/m', 'm/f', 'male/male', 'female/female', 'female/male', 'male/female', 'gen', 'multi', 'other']);

export const originalWorkLabels = ['original work', 'original works', 'original fiction', 'original-work', 'original-fiction'];
export function needsFandomReview(labels: IncomingLabel[], suppressed: IncomingLabel[], hasApprovedFandom = false): boolean {
  return (
    !hasApprovedFandom &&
    suppressed.length > 0 &&
    !labels.some(
      (label) =>
        (label.field === 'fandoms' && !!labelKey(label.value)) ||
        (['tags', 'genres'].includes(label.field) && originalWorkLabels.includes(labelKey(label.value))),
    )
  );
}

/** Resolve only approved aliases. Raw labels never become canonical entities here. */
export function matchLabels(source: string, labels: IncomingLabel[], rules: LabelRule[]): LabelResolution {
  const general = new Map<string, LabelRule>();
  const specific = new Map<string, LabelRule>();
  for (const rule of rules) {
    const key = JSON.stringify([rule.field, labelKey(rule.value)]);
    if (rule.source === null) general.set(key, rule);
    else if (rule.source === source) specific.set(key, rule);
  }
  const blocked = new Set(
    labels
      .filter((label) => label.field === 'characters' || (label.field === 'relationships' && !broadRelationships.has(labelKey(label.value))))
      .map((label) => labelKey(label.value)),
  );
  const targets = new Map<string, LabelTarget>();
  const pending = new Map<string, IncomingLabel>();
  const suppressed: IncomingLabel[] = [];
  const ignored: IncomingLabel[] = [];
  for (const label of labels) {
    const value = labelKey(label.value);
    if (!value) continue;
    const key = JSON.stringify([label.field, value]);
    const rule = specific.get(key) ?? general.get(key);
    if (
      label.field === 'characters' ||
      (label.field === 'relationships' && !broadRelationships.has(value)) ||
      ((label.field === 'tags' || label.field === 'genres') && blocked.has(value))
    ) {
      // Character rules may contribute approved fandoms, never character labels.
      if (rule?.fandomTargets?.length) {
        for (const target of rule.fandomTargets) targets.set(JSON.stringify([target.field, target.id]), target);
      } else suppressed.push(label);
      continue;
    }
    if (!rule && label.field === 'fandoms' && originalWorkLabels.includes(value)) {
      ignored.push(label);
      continue;
    }
    if (!rule) {
      pending.set(key, label);
      continue;
    }
    if (!rule.targets.length) ignored.push(label);
    for (const target of rule.targets) targets.set(JSON.stringify([target.field, target.id]), target);
  }
  return { targets: [...targets.values()], pending: [...pending.values()], suppressed, ignored };
}
