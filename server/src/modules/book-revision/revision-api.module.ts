import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module';
import { BookRevisionModule } from './book-revision.module';
import { RevisionApiService } from './revision-api.service';
import { RevisionController } from './revision.controller';

@Module({ imports: [BookRevisionModule, LibraryModule], providers: [RevisionApiService], controllers: [RevisionController] })
export class RevisionApiModule {}
