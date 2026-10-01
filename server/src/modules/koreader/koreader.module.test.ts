import { describe, expect, it } from 'vitest';

import { KoreaderAnnotationExchangeService } from './koreader-annotation-exchange.service';
import { KoreaderBookmarkExchangeService } from './koreader-bookmark-exchange.service';
import { KoreaderBookmarkRepository } from './koreader-bookmark.repository';
import { KoreaderAuthGuard } from './koreader-auth.guard';
import { KoreaderCatalogController } from './koreader-catalog.controller';
import { KoreaderCatalogService } from './koreader-catalog.service';
import { KoreaderChapterExtractorService } from './koreader-chapter-extractor.service';
import { KoreaderChapterService } from './koreader-chapter.service';
import { KoreaderController } from './koreader.controller';
import { KoreaderHashLinkService } from './koreader-hash-link.service';
import { KoreaderModule } from './koreader.module';
import { KoreaderDeliveryController, KoreaderPluginDeliveryController } from './koreader-delivery.controller';
import { KoreaderCopiesController, KoreaderPluginCopiesController } from './koreader-copy.controller';
import { KoreaderCopyService } from './koreader-copy.service';
import { KoreaderDeliveryService } from './koreader-delivery.service';
import { KoreaderDeliverySchedulerService } from './koreader-delivery-scheduler.service';
import { KoreaderDeliveryExecutionService } from './koreader-delivery-execution.service';
import { KoreaderDeliveryAccessService } from './koreader-delivery-access.service';
import { KoreaderReadingController } from './koreader-reading.controller';
import { KoreaderReadingService } from './koreader-reading.service';
import { KoreaderPackageService } from './koreader-package.service';
import { KoreaderPluginAnnotationService } from './koreader-plugin-annotation.service';
import { KoreaderPluginController } from './koreader-plugin.controller';
import { KoreaderPluginRepository } from './koreader-plugin.repository';
import { KoreaderPluginService } from './koreader-plugin.service';
import { KoreaderRepository } from './koreader.repository';
import { KoreaderService } from './koreader.service';
import { KoreaderStatsService } from './koreader-stats.service';
import { KoreaderSyncEstimateCleanupService } from './koreader-sync-estimate-cleanup.service';

describe('KoreaderModule', () => {
  it('registers expected controllers, providers, and exports', () => {
    expect(Reflect.getMetadata('controllers', KoreaderModule)).toEqual([
      KoreaderDeliveryController,
      KoreaderPluginDeliveryController,
      KoreaderCopiesController,
      KoreaderPluginCopiesController,
      KoreaderController,
      KoreaderPluginController,
      KoreaderCatalogController,
      KoreaderReadingController,
    ]);
    expect(Reflect.getMetadata('providers', KoreaderModule)).toEqual([
      KoreaderDeliverySchedulerService,
      KoreaderDeliveryService,
      KoreaderDeliveryExecutionService,
      KoreaderDeliveryAccessService,
      KoreaderCopyService,
      KoreaderService,
      KoreaderReadingService,
      KoreaderHashLinkService,
      KoreaderRepository,
      KoreaderAuthGuard,
      KoreaderCatalogService,
      KoreaderPackageService,
      KoreaderChapterService,
      KoreaderChapterExtractorService,
      KoreaderPluginService,
      KoreaderPluginRepository,
      KoreaderPluginAnnotationService,
      KoreaderAnnotationExchangeService,
      KoreaderBookmarkExchangeService,
      KoreaderBookmarkRepository,
      KoreaderStatsService,
      KoreaderSyncEstimateCleanupService,
    ]);
    expect(Reflect.getMetadata('exports', KoreaderModule)).toEqual([KoreaderService, KoreaderRepository]);
  });
});
