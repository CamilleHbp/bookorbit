import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import * as unzipper from 'unzipper';
import { checkEpubDirectoryBudget } from '../../common/archive/epub-directory-budget';

let activeReads = 0;

export async function openConversionArchive(path: string): Promise<unzipper.CentralDirectory> {
  if ((await stat(path)).size > 512 * 1024 * 1024) throw new BadRequestException('EPUB exceeds the conversion archive limit');
  await checkEpubDirectoryBudget(path);
  const archive = await unzipper.Open.file(path);
  if (archive.files.length > 10_000) throw new BadRequestException('EPUB exceeds the conversion entry limit');
  return archive;
}

export async function readConversionResource(entry: unzipper.File, limit: number): Promise<Buffer> {
  if (entry.type !== 'File' || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limit) {
    throw new BadRequestException('EPUB resource exceeds the conversion size limit');
  }
  if (activeReads >= 4) throw new ServiceUnavailableException('Position conversion is busy; retry later');
  activeReads++;
  let stream: ReturnType<unzipper.File['stream']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    stream = entry.stream();
    const activeStream = stream;
    timer = setTimeout(() => activeStream.destroy(new ServiceUnavailableException('EPUB resource reading timed out')), 5000);
    timer.unref();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit || bytes > entry.uncompressedSize) throw new BadRequestException('EPUB resource exceeds its declared size');
      chunks.push(buffer);
    }
    if (bytes !== entry.uncompressedSize) throw new BadRequestException('EPUB resource is truncated');
    return Buffer.concat(chunks, bytes);
  } finally {
    clearTimeout(timer);
    stream?.destroy();
    activeReads--;
  }
}
