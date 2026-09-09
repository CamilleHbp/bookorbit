import { Module } from '@nestjs/common';
import { FileLockService } from './file-lock.service';

@Module({ providers: [FileLockService], exports: [FileLockService] })
export class FileLockModule {}
