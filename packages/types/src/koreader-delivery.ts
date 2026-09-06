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
