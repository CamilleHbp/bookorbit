import { FanfictionLocationModule } from '../fanfiction/fanfiction-location.module';
import { Module } from '@nestjs/common';

import { BookConsolidationRepository } from './book-consolidation.repository';
import { BookConsolidationService } from './book-consolidation.service';

@Module({
  imports: [FanfictionLocationModule],
  providers: [BookConsolidationRepository, BookConsolidationService],
  exports: [BookConsolidationService],
})
export class BookConsolidationModule {}
