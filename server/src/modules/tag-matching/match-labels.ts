import type { IncomingLabel, LabelTarget, LabelRule, LabelResolution } from '@bookorbit/types';
export type { IncomingLabel, LabelTarget, LabelRule, LabelResolution } from '@bookorbit/types';
export function labelKey(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
const broadRelationships = new Set(['m/m', 'f/f', 'f/m', 'm/f', 'male/male', 'female/female', 'female/male', 'male/female', 'gen', 'multi', 'other']);

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
    if (
      label.field === 'characters' ||
      (label.field === 'relationships' && !broadRelationships.has(value)) ||
      ((label.field === 'tags' || label.field === 'genres') && blocked.has(value))
    ) {
      suppressed.push(label);
      continue;
    }
    const key = JSON.stringify([label.field, value]);
    const rule = specific.get(key) ?? general.get(key);
    if (!rule) {
      pending.set(key, label);
      continue;
    }
    if (!rule.targets.length) ignored.push(label);
    for (const target of rule.targets) targets.set(JSON.stringify([target.field, target.id]), target);
  }
  return { targets: [...targets.values()], pending: [...pending.values()], suppressed, ignored };
}
