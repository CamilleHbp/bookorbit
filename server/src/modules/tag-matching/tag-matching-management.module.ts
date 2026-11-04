import { TagMatchingJobsService } from './tag-matching-jobs.service';
import { TagMatchingModule } from './tag-matching.module';
import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module';
import { TagMatchingController } from './tag-matching.controller';
import { TagMatchingManagementService } from './tag-matching-management.service';
@Module({
  imports: [LibraryModule, TagMatchingModule],
  controllers: [TagMatchingController],
  providers: [TagMatchingManagementService, TagMatchingJobsService],
})
export class TagMatchingManagementModule {}
