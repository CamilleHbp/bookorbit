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

export interface FanfictionProfileDocument {
  configuration: string;
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
  cookieCount: number;
  cookies: FanfictionCookie[];
}

export type FanfictionJobKind = "preview" | "discovery" | "adopt" | "import" | "update" | "refresh" | "rollback";
export type FanfictionJobState =
  "queued" | "running" | "succeeded" | "no_change" | "review_required" | "configuration_blocked" | "failed" | "cancelled";

export interface FanfictionJob {
  id: string;
  libraryId: number;
  kind: FanfictionJobKind;
  state: FanfictionJobState;
  url: string;
  attempts: number;
  cancellationRequested: boolean;
  result: {
    preview?: FanfictionPreview;
    urls?: string[];
    sourceId?: string;
    bookId?: number;
    bookFileId?: number;
    revisionId?: string;
    noChange?: boolean;
    discovery?: FanfictionDiscoveryProgress;
    selection?: { processed: number; failed: number; finished: boolean };
  } | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FanfictionSourceState = "pending" | "active" | "paused" | "review_required" | "configuration_blocked" | "unlinked";

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

export interface FanfictionSource {
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
  kind: "imported" | "updated" | "rolled_back" | "attention" | "failed";
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
