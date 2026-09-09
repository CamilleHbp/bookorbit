import { Module } from '@nestjs/common';
import { UserBookStatusModule } from '../user-book-status/user-book-status.module';
import { BookProgressProjectionService } from './book-progress-projection.service';

@Module({
  imports: [UserBookStatusModule],
  providers: [BookProgressProjectionService],
  exports: [BookProgressProjectionService],
})
export class BookProgressModule {}
