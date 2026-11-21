import { ServiceUnavailableException } from '@nestjs/common';
import { statfs } from 'node:fs/promises';

const DISK_RESERVE = 1024n ** 3n;

export async function hasStorageHeadroom(directory: string, required = 0n): Promise<boolean> {
  const { bavail, bsize } = await statfs(directory, { bigint: true });
  return bavail * bsize >= required + DISK_RESERVE;
}

export async function requireStorageHeadroom(directory: string, required: bigint): Promise<void> {
  if (!(await hasStorageHeadroom(directory, required))) {
    throw new ServiceUnavailableException({ errorCode: 'download_storage_low', message: 'Waiting for free disk space' });
  }
}
