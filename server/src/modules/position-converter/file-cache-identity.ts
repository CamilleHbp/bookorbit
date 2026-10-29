import { stat } from 'node:fs/promises';

export async function fileCacheIdentity(path: string): Promise<string | null> {
  const file = await stat(path, { bigint: true });
  if (!file.isFile()) return null;
  return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
}
