import { readFile } from 'node:fs/promises';
import { hasStorageHeadroom } from '../../common/utils/storage-reserve';

const MiB = 1024 * 1024;

export async function downloadPressure(directory: string): Promise<'download_memory_limit' | 'download_storage_low' | undefined> {
  // availableMemory also accounts for a container limit. MemAvailable
  // includes reclaimable host cache when other services share the machine.
  const available = process.availableMemory();
  if (available < 256 * MiB) return 'download_memory_limit';
  if (process.platform === 'linux') {
    const info = await readFile('/proc/meminfo', 'utf8');
    const availableKiB = /^MemAvailable:\s+(\d+)/m.exec(info);
    if (availableKiB && Number(availableKiB[1]) < 1024 * 1024) return 'download_memory_limit';
  }
  if (!(await hasStorageHeadroom(directory))) return 'download_storage_low';
  return undefined;
}
