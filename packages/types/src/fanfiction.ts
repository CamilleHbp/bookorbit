export interface FanfictionPreferences {
  isAdult: boolean;
}

export interface FanfictionProfileMatch {
  profile: FanfictionProfileSummary | null;
}

export interface FanficfareRuntimeHealth {
  version: string | null;
  protocolVersion: 1;
  ready: boolean;
  errorCode?: string;
}

export interface FanfictionPreview {
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
  id: string;
  examples: string[];
}

export interface FanficfareSiteCatalog {
  version: string;
  sites: FanficfareSite[];
}

export type FanfictionRecognizedUrl =
  | { url: string; recognized: true; canonicalUrl: string; site: string }
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

export interface FanfictionProfileDocument {
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

export interface FanfictionProfileSummary {
  id: string;
  libraryId: number;
  name: string;
  version: number;
  updatedAt: string;
}

export interface FanfictionProfileView extends FanfictionProfileSummary {
  configuration: string;
  tagRules?: FanfictionTagRule[];
  cookieCount: number;
  cookies: FanfictionCookie[];
}

export type FanfictionJobKind = "preview" | "discovery" | "adopt" | "import" | "update" | "refresh" | "rollback" | "source_batch" | "replacement";
export type FanfictionJobState =
  "queued" | "running" | "succeeded" | "no_change" | "review_required" | "configuration_blocked" | "failed" | "cancelled";

export interface FanfictionImportProgress {
  stage: "metadata" | "downloading" | "packaging" | "validating" | "importing" | "finalizing";
  completedChapters?: number;
  totalChapters?: number;
}

export interface FanfictionJob {
  id: string;
  libraryId: number;
  kind: FanfictionJobKind;
  state: FanfictionJobState;
  url: string;
  attempts: number;
  cancellationRequested: boolean;
  result: {
    changes?: FanfictionChapterChanges;
    progress?: FanfictionImportProgress;
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
    selection?: { processed: number; failed: number; finished: boolean; action?: FanfictionSourceBatchAction };
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

export interface FanfictionDiscoveryPage {
  items: FanfictionDiscoveryCandidate[];
  nextCursor: string | null;
}

export interface FanfictionDiscoverySelection {
  cutoff: string;
  cursor: string | null;
  ids: string[] | null;
  state: FanfictionCandidateState;
  decision: "approve" | "reject";
  profileId: string | null;
  intervalMinutes: number | null;
  canonicalUrl?: string;
  processed: number;
  failed: number;
  retryFailedOnly?: boolean;
}

export type FanfictionSourceBatchAction = "update" | "refresh" | "retry" | "schedule";

export interface FanfictionSourceSelection {
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
  items: { sourceId: string; title: string; errorCode: string }[];
  nextCursor: string | null;
}

export interface FanfictionSource {
  sourceTitle?: string;
  categories?: FanfictionCategories | null;
  tagPolicy?: "review" | "automatic";
  reading?: FanfictionReading;
  id: string;
  libraryId: number;
  folderId: number | null;
  profileId: string | null;
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
  version: number;
  createdAt: string;
}

export interface FanfictionSourcePage {
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
  profileId?: string;
  folderId: number;
  intervalMinutes?: number | null;
}

export interface FanfictionLibraryPage {
  items: { id: number; name: string }[];
  nextCursor: number | null;
}

export interface FanfictionProfilePage {
  items: FanfictionProfileSummary[];
  nextCursor: string | null;
}

export interface FanfictionJobPage {
  items: FanfictionJob[];
  nextCursor: string | null;
}

export interface FanfictionActivity {
  id: string;
  libraryId: number;
  sourceId: string | null;
  jobId: string | null;
  kind: "imported" | "updated" | "rolled_back" | "attention" | "failed" | "batch_completed";
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
  tags: "keep" | "merge" | "select";
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
  profileId?: string;
  bookId: number;
  bookFileId: number;
  url: string;
}

export interface FanfictionChapterChanges {
  added: { href: string; title: string }[];
  changed: number;
  metadataChanged: boolean;
}
