import { UserModule } from '../user/user.module';
import { RevisionDownloadApiService } from './revision-download-api.service';
import { RevisionDownloadController } from './revision-download.controller';
import { ReadingEventApiService } from './reading-event-api.service';
import { ReadingEventController } from './reading-event.controller';
import { Module } from '@nestjs/common';
import { BookModule } from '../book/book.module';
import { BookRevisionModule } from './book-revision.module';
import { RevisionApiService } from './revision-api.service';
import { RevisionController } from './revision.controller';

@Module({
  imports: [BookRevisionModule, BookModule, UserModule],
  providers: [RevisionApiService, ReadingEventApiService, RevisionDownloadApiService],
  controllers: [RevisionController, ReadingEventController, RevisionDownloadController],
})
export class RevisionApiModule {}
