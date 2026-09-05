export interface RevisionChapter {
  href: string;
  title: string;
  sourceUrl?: string;
  textHash: string;
  length: number;
}

export interface EpubRevisionManifest {
  version: 1;
  chapters: RevisionChapter[];
  contentHash: string;
  metadataHash: string;
  coverHash: string | null;
}

export type RevisionPublicationState = "prepared" | "filesystem_published" | "database_committed" | "cleanup_complete" | "failed";
export type RevisionPublicationReason = "fanficfare" | "rollback";

export interface ReadingAnchor {
  schemaVersion?: 1;
  bookId?: number;
  bookFileId?: number;
  provisionalSha256?: string;
  nativeLocator?: { kind: "cfi" | "xpointer"; value: string };
  event?: ReadingEventIdentity;
  revision: string;
  chapterIndex: number;
  chapterHref?: string;
  chapterTitle?: string;
  chapterSourceUrl?: string;
  chapterTextHash?: string;
  chapterFraction: number;
  bookFraction: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
}

export interface ReadingEventIdentity {
  id: string;
  deviceId: string;
  deviceSequence: number;
  occurredAt: string;
  resetGeneration: number;
}

export interface RevisionPositionAcknowledgement {
  eventId: string;
  revision: string;
  nativeLocator: { kind: "cfi" | "xpointer"; value: string };
  quality: PositionResolutionQuality;
}

export type PositionResolutionQuality = "exact" | "relocated" | "approximate";

export interface ResolvedReadingAnchor {
  revision: string;
  chapterIndex: number;
  chapterFraction: number;
  bookFraction: number;
  quality: PositionResolutionQuality;
  reason: "passage" | "chapter" | "surviving_boundary" | "proportional";
  offset?: number;
}

export interface BookFileRevisionSummary {
  revision: string;
  bookFileId: number;
  sha256: string;
  fileHash: string;
  sizeBytes: number;
  createdAt: string;
}
