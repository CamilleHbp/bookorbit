import { BadRequestException } from '@nestjs/common';
import { open } from 'node:fs/promises';

export async function checkEpubDirectoryBudget(path: string): Promise<void> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const bytes = Math.min(size, 65557);
    const tail = Buffer.alloc(bytes);
    const read = await file.read(tail, 0, bytes, size - bytes);
    if (read.bytesRead !== bytes) throw new BadRequestException('EPUB archive changed during inspection');
    for (let offset = bytes - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + tail.readUInt16LE(offset + 20) !== bytes) continue;
      const count = tail.readUInt16LE(offset + 10);
      const directoryBytes = tail.readUInt32LE(offset + 12);
      const directoryOffset = tail.readUInt32LE(offset + 16);
      if (
        tail.readUInt16LE(offset + 4) ||
        tail.readUInt16LE(offset + 6) ||
        tail.readUInt16LE(offset + 8) !== count ||
        count > 10000 ||
        directoryBytes > 64 * 1024 * 1024 ||
        directoryOffset + directoryBytes > size - bytes + offset
      )
        throw new BadRequestException('EPUB directory exceeds the archive limits');
      return;
    }
    throw new BadRequestException('EPUB has no valid archive directory');
  } finally {
    await file.close();
  }
}
