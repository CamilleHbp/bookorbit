import { describe, expect, it } from 'vitest';
import { matchLabels, needsFandomReview, type LabelRule } from './match-labels';
const rules: LabelRule[] = [
  { source: null, field: 'tags', value: 'Old label', targets: [{ field: 'tags', id: 1 }] },
  { source: 'ao3', field: 'tags', value: 'Old label', targets: [{ field: 'tags', id: 2 }] },
  { source: null, field: 'fandoms', value: 'Fandom A', targets: [{ field: 'tags', id: 3 }] },
  { source: null, field: 'fandoms', value: 'Fandom B', targets: [{ field: 'tags', id: 4 }] },
];
describe('approved label matching', () => {
  it('does not request fandom decisions for original works or confuse original characters with original works', () => {
    const labels = [
      { field: 'fandoms' as const, value: ' Original Work ' },
      { field: 'characters' as const, value: 'An original character' },
    ];
    const result = matchLabels('ao3', labels, []);
    expect(result.pending).toEqual([]);
    expect(result.targets).toEqual([]);
    expect(needsFandomReview(labels, result.suppressed)).toBe(false);
    expect(needsFandomReview([{ field: 'characters', value: 'Original Character' }], result.suppressed)).toBe(true);
    expect(
      matchLabels('ao3', labels, [{ source: null, field: 'fandoms', value: 'Original Work', targets: [{ field: 'tags', id: 7 }] }]).targets,
    ).toEqual([{ field: 'tags', id: 7 }]);
  });
  it('normalizes whitespace and case and prefers source-specific aliases', () => {
    expect(matchLabels('ao3', [{ field: 'tags', value: ' OLD  label ' }], rules).targets).toEqual([{ field: 'tags', id: 2 }]);
    expect(matchLabels('file', [{ field: 'tags', value: 'Old label' }], rules).targets).toEqual([{ field: 'tags', id: 1 }]);
  });
  it('holds unknown labels without fuzzy matching or crossing fields', () => {
    const labels = [
      { field: 'tags' as const, value: 'Old labels' },
      { field: 'genres' as const, value: 'Old label' },
    ];
    expect(matchLabels('ao3', labels, rules)).toEqual({ targets: [], pending: labels, suppressed: [], ignored: [] });
  });
  it('lets an explicit ignore override a general mapping', () => {
    expect(
      matchLabels('ao3', [{ field: 'tags', value: 'Old label' }], [...rules, { source: 'ao3', field: 'tags', value: 'Old label', targets: [] }]),
    ).toEqual({ targets: [], pending: [], suppressed: [], ignored: [{ field: 'tags', value: 'Old label' }] });
  });
  it('suppresses names across fields and retains only this work’s fandoms', () => {
    const result = matchLabels(
      'ao3',
      [
        { field: 'characters', value: 'Alice' },
        { field: 'genres', value: 'alice' },
        { field: 'relationships', value: 'Alice/Bob' },
        { field: 'tags', value: 'Alice/Bob' },
        { field: 'fandoms', value: 'Fandom A' },
      ],
      [...rules, { source: 'ao3', field: 'characters', value: 'Alice', targets: [{ field: 'tags', id: 99 }] }],
    );
    expect(result.targets).toEqual([{ field: 'tags', id: 3 }]);
    expect(result.suppressed).toHaveLength(4);
    expect(result.pending).toEqual([]);
  });
  it('retains crossover fandoms and holds missing matches without restoring characters', () => {
    const result = matchLabels(
      'ao3',
      [
        { field: 'characters', value: 'Alice' },
        { field: 'fandoms', value: 'Fandom A' },
        { field: 'fandoms', value: 'Fandom B' },
        { field: 'fandoms', value: 'Unknown' },
      ],
      rules,
    );
    expect(result.targets).toHaveLength(2);
    expect(result.pending).toEqual([{ field: 'fandoms', value: 'Unknown' }]);
    expect(result.suppressed).toHaveLength(1);
  });
  it('allows approved broad relationships and deduplicates destinations', () => {
    const result = matchLabels(
      'ao3',
      [{ field: 'relationships', value: 'M/M' }],
      [
        {
          source: null,
          field: 'relationships',
          value: 'm/m',
          targets: [
            { field: 'tags', id: 5 },
            { field: 'tags', id: 5 },
          ],
        },
      ],
    );
    expect(result.targets).toEqual([{ field: 'tags', id: 5 }]);
    expect(result.suppressed).toEqual([]);
  });
});
