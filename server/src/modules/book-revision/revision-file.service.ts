import { ConflictException, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { inspectStableFile, sameFileSignature, type InspectedFile } from './file-inspection';
import { copyBoundedFile, requireInspectedFile, syncPath } from './revision-publication.files';

@Injectable()
export class RevisionFileService {
  inspect = inspectStableFile;
  require = requireInspectedFile;
  copy = copyBoundedFile;
  sync = syncPath;

  async verifyUnchanged(path: string, inspected: InspectedFile): Promise<void> {
    const current = await stat(path, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConflictException('File disappeared before its identity could be saved');
      throw error;
    });
    if (!sameFileSignature(inspected.signature, current)) {
      throw new ConflictException('File changed before its identity could be saved');
    }
  }
}
