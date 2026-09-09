import { Module } from '@nestjs/common';

import { BookModule } from '../../book/book.module';
import { LibraryModule } from '../../library/library.module';
import { EpubController } from './epub.controller';
import { EpubService } from './epub.service';
import { BookRevisionModule } from '../../book-revision/book-revision.module';
import { UserModule } from '../../user/user.module';
import { EpubRevisionService } from './epub-revision.service';
import { EpubRevisionController } from './epub-revision.controller';

@Module({
  imports: [BookModule, LibraryModule, BookRevisionModule, UserModule],
  controllers: [EpubController, EpubRevisionController],
  providers: [EpubService, EpubRevisionService],
})
export class EpubModule {}
