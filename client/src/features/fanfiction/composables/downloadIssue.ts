import { Link2Off, Pause, CircleHelp, Globe, KeyRound, BookOpenCheck, ListChecks, PencilLine } from '@lucide/vue'
export const issueStyle = {
  website: { icon: Globe, color: 'text-info bg-info/10' },
  login: { icon: KeyRound, color: 'text-warning bg-warning/10' },
  chapter: { icon: BookOpenCheck, color: 'text-primary bg-primary/10' },
  metadata: { icon: PencilLine, color: 'text-primary bg-primary/10' },
  import: { icon: ListChecks, color: 'text-primary bg-primary/10' },
  story: { icon: Link2Off, color: 'text-warning bg-warning/10' },
  stopped: { icon: Pause, color: 'text-muted-foreground bg-muted' },
  unknown: { icon: CircleHelp, color: 'text-destructive bg-destructive/10' },
}
export function chapterDecision(changes?: { removed?: number; changed?: number; reordered?: boolean } | null) {
  if (changes?.removed) return { key: 'removed', count: changes.removed }
  if (changes?.changed) return { key: 'changed', count: changes.changed }
  if (changes?.reordered) return { key: 'reordered', count: 0 }
  return { key: 'unmatched', count: 0 }
}
