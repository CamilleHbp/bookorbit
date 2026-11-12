import type { IncomingLabel } from "./tag-matching";
export interface FanfictionPreferences {
  isAdult: boolean;
  defaultUpdatePolicy?: FanfictionUpdatePolicy;
}

export type FanfictionUpdatePolicy = "review" | "safe";
export interface FanfictionWebsite {
  id: string;
  name: string;
  examples: string[];
  access: "login" | "cookies";
  usernameKind?: "email";
}
export interface FanfictionConnection {
  id: string;
  website: FanfictionWebsite;
  version: number;
  hasPassword: boolean;
  cookieCount: number;
  lastSuccessfulAt: string | null;
  errorCode: string | null;
  updatedAt: string;
}
export interface FanfictionConnectionSettings {
  configuration: string;
  tagRules: FanfictionTagRule[];
}
export interface FanfictionConnectionRequest {
  configuration?: string;
  tagRules?: FanfictionTagRule[];
  site: string;
  version?: number;
  username?: string;
  password?: string;
  cookies?: FanfictionCookie[];
}
export interface FanfictionStoryTracking {
  enabled: boolean;
  policy: FanfictionUpdatePolicy;
  maintainerUserId: number | null;
  needsAttention: boolean;
}
export interface FanfictionConnectionIssue {
  site: string;
  count: number;
  connectionId: string | null;
}

export interface FanficfareRuntimeHealth {
  version: string | null;
  protocolVersion: 1;
  ready: boolean;
  errorCode?: string;
}

export interface FanfictionPreview {
  rawLabels?: IncomingLabel[];
  labelMappingVersion?: number;
  pendingLabelCount?: number;
  canonicalUrl: string;
  site: string;
  title: string;
  authors: string[];
  description: string;
  chapterCount: number;
  wordCount?: number | null;
  status: string;
  tags: string[];
  genres?: string[];
  categories?: FanfictionCategories;
}

export interface FanfictionCategories {
  fandoms: string[];
  relationships: string[];
  characters: string[];
  warnings: string[];
  rating: string;
}

export interface FanficfareSite {
  supportsPasswordLogin?: boolean;
  id: string;
  examples: string[];
}

export interface FanficfareSiteCatalog {
  version: string;
  sites: FanficfareSite[];
}

export type FanfictionRecognizedUrl =
  | { url: string; recognized: true; canonicalUrl: string; identityUrl?: string; site: string }
  | { url: string; recognized: false; reason: "unsupported" | "unsafe" | "access_required" };

export interface FanfictionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly?: boolean;
  expires?: number;
}

export interface FanfictionTagRule {
  remoteTag: string;
  targetTag: string;
}

export interface FanfictionConnectionDocument {
  tagMatching?: {
    version: number;
    rules: Array<{
      source: string | null;
      unresolved?: boolean;
      field: import("./tag-matching").LabelField;
      value: string;
      targets: Array<{ field: "tags" | "genres"; name: string }>;
    }>;
  };
  configuration: string;
  tagRules?: FanfictionTagRule[];
  cookies: FanfictionCookie[];
}

export interface EncryptedFanfictionDocument {
  version: 1;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export type FanfictionJobKind = "preview" | "discovery" | "adopt" | "import" | "update" | "refresh" | "rollback" | "source_batch" | "replacement";
export type FanfictionJobState =
  "queued" | "running" | "succeeded" | "no_change" | "review_required" | "configuration_blocked" | "failed" | "cancelled";

export interface FanfictionImportProgress {
  stage: "metadata" | "downloading" | "packaging" | "validating" | "importing" | "finalizing";
  completedChapters?: number;
  reusedChapters?: number;
  totalChapters?: number;
}

export interface FanfictionJob {
  reviewWebsite?: string;
  sourceTitle?: string;
  id: string;
  libraryId: number;
  kind: FanfictionJobKind;
  state: FanfictionJobState;
  url: string;
  attempts: number;
  nextAttemptAt?: string;
  cancellationRequested: boolean;
  result: {
    contentReview?: { approved: boolean; previousState: "active" | "paused" };
    metadataDeferred?: boolean;
    changes?: FanfictionChapterChanges;
    progress?: FanfictionImportProgress;
    chapterRestartId?: string;
    existingStory?: FanfictionExistingStory;
    existingImportId?: string;
    preview?: FanfictionPreview;
    replacement?: FanfictionReplacementReview;
    metadataReview?: FanfictionMetadataReview;
    preparedUpdate?: {
      noChange: boolean;
      previousState: "active" | "paused";
      values: FanfictionMetadataValues;
      fields: FanfictionMetadataField[];
      fingerprint: string;
      approved: boolean;
      metadataApplied?: boolean;
      personalTags?: string[];
      replaceTags?: boolean;
      reviewedFields?: FanfictionMetadataField[];
      baseline?: FanfictionMetadataValues;
    };
    importReview?: { preview: FanfictionPreview; values: FanfictionMetadataValues; approved: boolean };
    reviewDiscarded?: boolean;
    urls?: string[];
    sourceId?: string;
    bookId?: number;
    bookFileId?: number;
    revisionId?: string;
    noChange?: boolean;
    discovery?: FanfictionDiscoveryProgress;
    selection?: { tracked?: boolean; processed: number; failed: number; finished: boolean; action?: FanfictionSourceBatchAction };
  } | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FanfictionSourceState = "pending" | "active" | "paused" | "review_required" | "configuration_blocked" | "unlinked";

export interface FanfictionExistingStory {
  id: string;
  title: string;
  bookId?: number;
  attentionCode?: string | null;
}

export interface FanfictionMetadataReviewConflict {
  errorCode: "metadata_review_required";
  errorMeta: { sourceId: string; bookId: number };
}

export interface FanfictionExistingStoryConflict {
  errorCode: "story_exists";
  errorMeta: FanfictionExistingStory;
}

export interface FanfictionDiscoveryProgress {
  cutoffFileId: number;
  cursorFileId: number;
  scanned: number;
  candidates: number;
  failed: number;
  finished: boolean;
}

export type FanfictionCandidateState = "pending" | "ambiguous" | "rejected" | "linked" | "failed";

export interface FanfictionDiscoveryCandidate {
  id: string;
  libraryId: number;
  bookId: number;
  bookFileId: number;
  sha256: string;
  title: string;
  authors: string[];
  chapterCount: number;
  urls: FanfictionRecognizedUrl[];
  state: FanfictionCandidateState;
  errorCode: string | null;
  sourceId: string | null;
  reviewJobId: string | null;
  version: number;
  createdAt: string;
}

export interface FanfictionDiscoveryWebsite {
  website: string;
  total: number;
  remaining: number;
  linked: number;
}
export interface FanfictionDiscoveryWebsites {
  items: FanfictionDiscoveryWebsite[];
  nextCursor: string | null;
  cutoff: string;
}
export interface FanfictionDiscoveryComparison {
  canonicalUrl: string;
  title: string;
  authors: string[];
  chapterCount: number;
}
export interface FanfictionDiscoveryPage {
  total?: number;
  items: FanfictionDiscoveryCandidate[];
  nextCursor: string | null;
}

export interface FanfictionDiscoveryOverride {
  id: string;
  canonicalUrl?: string;
}

export interface FanfictionDiscoverySelection {
  website?: string;
  review?: boolean;
  excludedIds?: string[];
  overrides?: FanfictionDiscoveryOverride[];
  urlPrefixes?: string[];
  cutoff: string;
  cursor: string | null;
  ids: string[] | null;
  state: FanfictionCandidateState;
  decision: "approve" | "reject";
  intervalMinutes: number | null;
  canonicalUrl?: string;
  processed: number;
  failed: number;
  retryFailedOnly?: boolean;
}

export type FanfictionSourceBatchAction = "update" | "refresh" | "retry" | "schedule" | "policy";

export interface FanfictionSourceSelection {
  priorityPhase?: "in_progress" | "remaining";
  repairConnectionSite?: string;
  updatePolicy?: FanfictionUpdatePolicy;
  excludePaused?: boolean;
  total?: number;
  tracksOutcomes?: boolean;
  cutoff: string;
  cursor: string | null;
  ids: string[] | null;
  search: string | null;
  state: FanfictionSourceState | null;
  action: FanfictionSourceBatchAction;
  intervalMinutes: number | null;
  processed: number;
  failed: number;
  retryFailedOnly?: boolean;
}

export interface FanfictionSourceBatchFailurePage {
  items: {
    sourceId: string;
    title: string;
    errorCode: string;
    jobId?: string | null;
    bookId?: number | null;
    site?: string;
  }[];
  nextCursor: string | null;
}

export interface FanfictionSourceBatchScope {
  eligible?: number;
  total: number;
  matching: number;
}

export interface FanfictionSourceBatchStatus {
  job: FanfictionJob;
  total: number | null;
  checked: number;
  updated: number;
  unchanged: number;
  needsAttention: number;
  running: number;
  waiting: number;
  finished: boolean;
  trackingAvailable: boolean;
}

export interface IgnoreMissingStoryWarningRequest {
  version: number;
  ignoreWarning: "source_not_found";
}

export interface FanfictionSource {
  tracking?: FanfictionStoryTracking;
  sourceTitle?: string;
  categories?: FanfictionCategories | null;
  tagPolicy?: "review" | "automatic";
  reading?: FanfictionReading;
  id: string;
  libraryId: number;
  folderId: number | null;
  bookId: number | null;
  bookFileId: number | null;
  canonicalUrl: string;
  site: string;
  title: string;
  authors: string[];
  state: FanfictionSourceState;
  chapterCount: number;
  wordCount: number | null;
  storyStatus: string;
  intervalMinutes: number | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  attentionCode: string | null;
  metadataReviewPending?: boolean;
  version: number;
  createdAt: string;
}

export interface FanfictionSourcePage {
  /** Total matching stories on the first page of a review queue. */
  total?: number;
  items: FanfictionSource[];
  nextCursor: string | null;
}

export interface FanfictionFolderPage {
  items: { id: number; path: string }[];
  nextCursor: number | null;
}

export interface FanfictionImportRequest {
  collectionId?: number;
  url: string;
  idempotencyKey: string;
  folderId: number;
  intervalMinutes?: number | null;
}

export interface FanfictionLibraryPage {
  items: { id: number; name: string }[];
  nextCursor: number | null;
}

export interface FanfictionJobPage {
  recentDownloads?: Array<{ id: string; title: string; bookId: number }>;
  items: FanfictionJob[];
  nextCursor: string | null;
}

export type FanfictionActivityKind = "imported" | "updated" | "rolled_back" | "attention" | "failed" | "batch_completed";

export interface FanfictionActivity {
  id: string;
  libraryId: number;
  sourceId: string | null;
  jobId: string | null;
  kind: FanfictionActivityKind;
  title: string;
  bookId: number | null;
  revisionId: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface FanfictionActivityPage {
  items: FanfictionActivity[];
  nextCursor: string | null;
}

export interface FanfictionActivitySummary {
  since: string;
  counts: Record<FanfictionActivityKind, number>;
  updatedStories: number;
}

export interface FanfictionReplacementReview {
  sha256: string;
  expectedRevisionId: string;
  title: string;
  authors: string[];
  previousChapterCount: number;
  chapterCount: number;
  identityMatches: boolean;
}

export type FanfictionMetadataField = "title" | "description" | "authors" | "tags" | "genres";
export type FanfictionReviewScope = "pending" | "all";
export type FanfictionMetadataValues = Pick<FanfictionPreview, FanfictionMetadataField>;
export interface FanfictionMetadataReview {
  current: FanfictionMetadataValues;
  incoming: FanfictionMetadataValues;
  fields: FanfictionMetadataField[];
  lockedFields: string[];
  fingerprint: string;
  previousState: "active" | "paused";
  beforeUpdate?: boolean;
  tags?: { custom: string[]; managed: string[]; added: string[]; removed: string[] };
  choices?: FanfictionMetadataChoices;
}
export type FanfictionMetadataChoices = Pick<
  FanfictionMetadataResolution,
  "title" | "description" | "authors" | "tags" | "genres" | "selectedTags" | "values" | "keepAll"
>;
export interface FanfictionMetadataReviewView {
  jobId: string;
  review: FanfictionMetadataReview;
}
export interface FanfictionMetadataResolution {
  jobId: string;
  fingerprint: string;
  title: "keep" | "incoming" | "edit";
  description: "keep" | "incoming" | "edit";
  authors: "keep" | "incoming" | "edit";
  genres?: "keep" | "incoming" | "edit";
  values?: FanfictionMetadataValues;
  keepAll?: boolean;
  tags: "keep" | "merge" | "select" | "edit";
  selectedTags?: string[];
}

export interface FanfictionImportReviewRequest {
  action: "apply" | "later" | "discard";
  values?: FanfictionMetadataValues;
}

export interface FanfictionReading {
  status: "unread" | "reading" | "caught_up" | "finished";
  readChapters: number | null;
  unreadChapters: number | null;
  totalChapters: number;
  nextChapterHref?: string;
}
export interface FanfictionReaderStory {
  id: string;
  bookId: number;
  bookFileId: number;
  title: string;
  canonicalUrl: string;
  storyStatus: string;
  chapterCount: number;
  lastUpdatedAt: string | null;
  categories: FanfictionCategories | null;
  reading: FanfictionReading;
}

export interface FanfictionLinkPreview {
  remote: FanfictionPreview;
  id: string;
  title: string;
  authors: string[];
  chapterCount: number;
  canonicalUrl: string;
  state: "pending" | "ambiguous";
}
export interface FanfictionLinkRequest {
  bookId: number;
  bookFileId: number;
  url: string;
}

export interface FanfictionChapterDifference {
  saved?: { position: number; title: string; excerpt?: string };
  website?: { position: number; title: string; excerpt?: string };
}

export interface FanfictionChapterChanges {
  differences?: FanfictionChapterDifference[];
  incompletePreview?: boolean;
  differentStory?: boolean;
  safety?: "insert_only" | "append_only" | "unchanged" | "review_required";
  removed?: number;
  inserted?: boolean;
  reordered?: boolean;
  added: { href: string; title: string }[];
  changed: number;
  metadataChanged: boolean;
}

export interface FanfictionLabelEdits {
  tags?: { added: string[]; removed: string[] };
  genres?: { added: string[]; removed: string[] };
}

export type FanfictionDownloadSection = "running" | "queued" | "retrying" | "attention";
export type FanfictionDownloadIssue = "website" | "login" | "chapter" | "metadata" | "import" | "story" | "stopped" | "unknown";

export interface FanfictionDownloadRow {
  verificationUrl?: string | null;
  id: string;
  section: FanfictionDownloadSection;
  issue: FanfictionDownloadIssue | null;
  groupKey: string | null;
  count: number;
  jobId: string | null;
  sourceId: string | null;
  bookId: number | null;
  site: string;
  title: string;
  kind: FanfictionJobKind | null;
  code: string | null;
  nextAttemptAt: string | null;
  progress: FanfictionImportProgress | null;
  removed: number;
  changed: number;
  inserted?: boolean;
  reordered: boolean;
  currentChapters: number | null;
  proposedChapters: number | null;
}

export interface FanfictionGroupRetryResult {
  queued: number;
  skipped: number;
}

export interface FanfictionDownloadQueue {
  items: FanfictionDownloadRow[];
  totals: Record<FanfictionDownloadSection, number>;
  recent: NonNullable<FanfictionJobPage["recentDownloads"]>;
}
