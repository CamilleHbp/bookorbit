export type LabelField = "tags" | "genres" | "fandoms" | "characters" | "relationships" | "warnings" | "rating";
export interface IncomingLabel {
  field: LabelField;
  value: string;
}
export interface LabelTarget {
  field: "tags" | "genres";
  id: number;
}
export interface LabelRule {
  source: string | null;
  field: LabelField;
  value: string;
  targets: LabelTarget[];
}
export interface LabelResolution {
  targets: LabelTarget[];
  pending: IncomingLabel[];
  suppressed: IncomingLabel[];
  ignored: IncomingLabel[];
}
export interface TagMatchingRule extends LabelRule {
  action: "match" | "ignore";
  id: string;
  version: number;
  targetNames: string[];
  bookCount: number;
}
export interface TagMatchingPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  version: number;
}
export interface TagMatchingReviewItem {
  bookId?: number | null;
  sourceKey?: string | null;
  source: string;
  field: LabelField;
  value: string;
  bookCount: number;
}
export interface TagMatchingSuggestion extends LabelTarget {
  name: string;
  score: number;
}
export interface TagMatchingChange {
  bookId: number;
  title: string;
  addedTags: string[];
  removedTags: string[];
  addedGenres: string[];
  removedGenres: string[];
  lockedFields: string[];
  unresolved: number;
}
export interface TagMatchingApplyJob {
  id: string;
  state: "previewing" | "ready" | "running" | "completed" | "failed";
  version: number;
  processed: number;
  changed: number;
  skipped: number;
  error: string | null;
}

export interface TagMatchingJobPage {
  job: TagMatchingApplyJob;
  items: Array<{ change: TagMatchingChange; state: "pending" | "applied" | "skipped"; overrideFields: Array<"tags" | "genres"> }>;
  total: number;
  page: number;
  pageSize: number;
}

export interface TagMatchingPreviewLabel extends IncomingLabel {
  source: string;
  sourceKey: string;
  status: "matched" | "pending" | "ignored" | "suppressed" | "missing-fandom";
  targets: Array<LabelTarget & { name: string; excluded: boolean }>;
}
export interface TagMatchingBookPreview {
  change: TagMatchingChange;
  protectedChanges: Pick<TagMatchingChange, "addedTags" | "removedTags" | "addedGenres" | "removedGenres">;
  labels: TagMatchingPreviewLabel[];
  total: number;
  page: number;
  pageSize: number;
}
