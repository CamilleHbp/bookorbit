const TOKEN_PREFIX = 'PX.';
// Carries Kobo's cursor verbatim after the snapshot id: `PX2.<snapshotId>.<kobo token>`. Kobo's token
// already travels in a header, and wrapping it in JSON and base64 again grew it by a third.
const COMPACT_TOKEN_PREFIX = 'PX2.';

// Kobo's own sync tokens are opaque and we round-trip them through the device inside ours, so a
// hostile or corrupted upstream value cannot be allowed to grow the response header without bound.
// A small store library already produces a 3,300 character cursor and continuation pages carry more,
// so this leaves room for those while the whole header stays under the common 8 KB proxy line limit.
// Anything larger is dropped, and store paging for that sync stops instead of restarting.
const MAX_KOBO_SYNC_TOKEN_LENGTH = 7000;

export type KoboSyncTokenParts = {
  snapshotId?: number;
  koboSyncToken?: string;
};

/**
 * Whether an upstream cursor is small enough to carry. Callers holding a logger should check this
 * before handing a cursor over, because dropping one silently restarts store paging from scratch.
 */
export function isUsableKoboSyncToken(koboSyncToken: string): boolean {
  return koboSyncToken.length > 0 && koboSyncToken.length <= MAX_KOBO_SYNC_TOKEN_LENGTH;
}

export function encodeSyncToken(snapshotId: number, koboSyncToken?: string): string {
  const usableKoboToken = koboSyncToken && isUsableKoboSyncToken(koboSyncToken) ? koboSyncToken : undefined;
  if (usableKoboToken) return `${COMPACT_TOKEN_PREFIX}${snapshotId}.${usableKoboToken}`;
  return TOKEN_PREFIX + Buffer.from(JSON.stringify({ snapshotId })).toString('base64');
}

/**
 * Tokens minted before store sync existed carry only {snapshotId}, and a device that synced against
 * Kobo directly before BookOrbit was put in the path sends Kobo's own opaque token. Neither shape
 * may throw: getDelta finds the snapshot by device rather than by token, so a token we cannot read
 * costs a store page, never a broken sync.
 */
export function decodeSyncToken(raw: string | undefined): KoboSyncTokenParts {
  const value = raw?.trim();
  if (!value) return {};
  if (value.startsWith(COMPACT_TOKEN_PREFIX)) {
    const rest = value.slice(COMPACT_TOKEN_PREFIX.length);
    const separator = rest.indexOf('.');
    const id = separator === -1 ? rest : rest.slice(0, separator);
    const koboSyncToken = separator === -1 ? '' : rest.slice(separator + 1);
    return {
      snapshotId: /^\d{1,15}$/.test(id) ? Number(id) : undefined,
      koboSyncToken: isUsableKoboSyncToken(koboSyncToken) ? koboSyncToken : undefined,
    };
  }
  if (!value.startsWith(TOKEN_PREFIX)) {
    return isUsableKoboSyncToken(value) ? { koboSyncToken: value } : {};
  }

  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(TOKEN_PREFIX.length), 'base64').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return {};
    const { snapshotId, koboSyncToken } = decoded as Record<string, unknown>;
    const usableKoboToken = typeof koboSyncToken === 'string' && isUsableKoboSyncToken(koboSyncToken) ? koboSyncToken : undefined;
    return {
      snapshotId: typeof snapshotId === 'number' && Number.isFinite(snapshotId) ? snapshotId : undefined,
      koboSyncToken: usableKoboToken,
    };
  } catch {
    return {};
  }
}

/**
 * Re-stamps a token minted by KoboSyncService with the upstream cursor. Returns the token unchanged
 * when there is no upstream cursor to carry, so a sync with store sync off is byte-identical to one
 * from before store sync existed.
 */
export function withKoboSyncToken(compositeToken: string, koboSyncToken: string | undefined): string {
  if (!koboSyncToken) return compositeToken;
  const { snapshotId } = decodeSyncToken(compositeToken);
  if (snapshotId === undefined) return compositeToken;
  return encodeSyncToken(snapshotId, koboSyncToken);
}
