import { TagMatchingLifecycleService } from './tag-matching-lifecycle.service';
import { Module } from '@nestjs/common';
import { TagMatchingService } from './tag-matching.service';
@Module({ providers: [TagMatchingService, TagMatchingLifecycleService], exports: [TagMatchingService, TagMatchingLifecycleService] })
export class TagMatchingModule {}
