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

export interface FanfictionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
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
}

export type FanfictionJobKind = "preview" | "discovery" | "import" | "update" | "refresh" | "rollback";
export type FanfictionJobState = "queued" | "running" | "succeeded" | "no_change" | "review_required" | "configuration_blocked" | "failed" | "cancelled";

export interface FanfictionJob {
  id: string;
  libraryId: number;
  kind: FanfictionJobKind;
  state: FanfictionJobState;
  url: string;
  attempts: number;
  cancellationRequested: boolean;
  result: { preview?: FanfictionPreview; urls?: string[] } | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
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
