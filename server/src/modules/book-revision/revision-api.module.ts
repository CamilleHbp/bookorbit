import { ReadingEventApiService } from './reading-event-api.service';
import { ReadingEventController } from './reading-event.controller';
import { Module } from '@nestjs/common';
import { BookModule } from '../book/book.module';
import { BookRevisionModule } from './book-revision.module';
import { RevisionApiService } from './revision-api.service';
import { RevisionController } from './revision.controller';

@Module({
  imports: [BookRevisionModule, BookModule],
  providers: [RevisionApiService, ReadingEventApiService],
  controllers: [RevisionController, ReadingEventController],
})
export class RevisionApiModule {}
