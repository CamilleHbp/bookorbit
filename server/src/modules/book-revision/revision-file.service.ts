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
    if (!sameFileSignature(inspected.signature, await stat(path, { bigint: true }))) {
      throw new ConflictException('File changed before its identity could be saved');
    }
  }
}
