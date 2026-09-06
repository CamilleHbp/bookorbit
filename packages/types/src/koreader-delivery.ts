export type KoreaderDeliveryPolicy = "notify" | "automatic" | "ignore";

export interface KoreaderCopyPolicyUpdate {
  version: number;
  policy: KoreaderDeliveryPolicy | null;
}

export interface KoreaderDevicePolicyUpdate {
  version: number;
  policy: KoreaderDeliveryPolicy;
}

export interface KoreaderInstalledCopyReport {
  copyId: string;
  bookFileId: number;
  pathname: string;
  sha256: string;
  sizeBytes: number;
  revisionId?: string | null;
  policyAcknowledgement?: string;
}

export interface KoreaderCopyInventoryRequest {
  protocolVersion: 1;
  deviceId: string;
  sequence: number;
  pluginVersion: string;
  deliveryCapabilityVersion: number;
  positionCapabilityVersion: number;
  copies: KoreaderInstalledCopyReport[];
}

export interface KoreaderInstalledCopy {
  id: string;
  copyId: string;
  deviceId: string;
  bookId: number;
  bookFileId: number;
  pathname: string;
  sha256: string;
  sizeBytes: number;
  revisionId: string | null;
  currentRevisionId: string | null;
  currentSha256: string | null;
  identity: "known" | "provisional";
  policy: KoreaderDeliveryPolicy;
  policyOverride: KoreaderDeliveryPolicy | null;
  policyVersion: number;
  effectivePolicyVersion: string;
  policyAcknowledged: boolean;
  lastContactAt: string;
  deliveryCapabilityVersion: number;
  positionCapabilityVersion: number;
}

export interface KoreaderCopyInventoryResult {
  nextSequence: number;
  copies: {
    copyId: string;
    status: "accepted" | "unchanged" | "stale" | "conflict" | "unavailable";
    id?: string;
    revisionId?: string | null;
    policy?: KoreaderDeliveryPolicy;
    effectivePolicyVersion?: string;
  }[];
}

export interface KoreaderInstalledCopyPage {
  items: KoreaderInstalledCopy[];
  nextCursor: string | null;
}

export interface KoreaderDeliveryDevice {
  deviceId: string;
  pluginVersion: string;
  policy: KoreaderDeliveryPolicy;
  policyVersion: number;
  deliveryCapabilityVersion: number;
  positionCapabilityVersion: number;
  lastContactAt: string;
}

export interface KoreaderDeliveryDevicePage {
  items: KoreaderDeliveryDevice[];
  nextCursor: string | null;
}

export type KoreaderInstallationState = "requested" | "waiting_for_uploads" | "waiting_for_close" | "downloading" | "installed";
export type KoreaderRestorationState = "verification_pending" | "verified" | "approximate" | "failed";
export type KoreaderDeliveryFailure =
  | "access_revoked"
  | "revision_changed"
  | "copy_changed"
  | "upload_failed"
  | "download_failed"
  | "verification_failed"
  | "publication_failed"
  | "configuration_blocked";

export interface KoreaderDeliveryJob {
  id: string;
  installedCopyId: string;
  copyId: string;
  deviceId: string;
  bookFileId: number;
  libraryId: number;
  revisionId: string;
  sha256: string;
  sizeBytes: number;
  expectedLocalSha256: string;
  expectedLocalSizeBytes: number;
  pathname: string;
  mode: "manual" | "automatic";
  installationState: KoreaderInstallationState;
  restorationState: KoreaderRestorationState;
  failureCode: KoreaderDeliveryFailure | null;
  restorationFailureCode: string | null;
  cancelledAt: string | null;
  version: number;
  attempt: number;
  installedAt: string | null;
  restoredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KoreaderDeliveryJobPage {
  items: KoreaderDeliveryJob[];
  nextCursor: string | null;
}

export interface RequestKoreaderDelivery {
  idempotencyKey: string;
  expectedRevisionId: string;
}

export interface KoreaderDeliveryLease {
  job: KoreaderDeliveryJob;
  token: string;
  fence: number;
  expiresAt: string;
}

export interface ClaimKoreaderDelivery {
  deviceId: string;
  claimId: string;
}

export interface KoreaderDeliveryLeaseIdentity {
  deviceId: string;
  token: string;
  fence: number;
}

export interface KoreaderDeliveryProgress extends KoreaderDeliveryLeaseIdentity {
  sequence: number;
  state: Exclude<KoreaderInstallationState, "requested">;
  localSha256: string;
  localSizeBytes: number;
  pathname: string;
  readingUploadsComplete: boolean;
  publicationToken?: string;
  failureCode?: KoreaderDeliveryFailure;
}

export interface KoreaderPublicationPermit {
  token: string;
  expiresAt: string;
  validForMs: number;
  revisionId: string;
  sha256: string;
  sizeBytes: number;
}
