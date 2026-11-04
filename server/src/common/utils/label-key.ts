export function labelKey(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
