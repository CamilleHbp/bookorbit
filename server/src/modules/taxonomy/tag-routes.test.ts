import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { EntityManagerService } from '../entity-manager/entity-manager.service';
import { TagsController as TagBrowserController } from '../entity-manager/tags.controller';
import { GenresController, TagsController } from './taxonomy.controller';
import { TaxonomyService } from './taxonomy.service';

it('registers taxonomy and grouped tag browsing routes together', async () => {
  const module = await Test.createTestingModule({
    controllers: [GenresController, TagsController, TagBrowserController],
    providers: [
      { provide: EntityManagerService, useValue: {} },
      { provide: TaxonomyService, useValue: {} },
    ],
  }).compile();
  const adapter = new FastifyAdapter();
  const app = module.createNestApplication<NestFastifyApplication>(adapter);
  app.setGlobalPrefix('api/v1');
  try {
    await app.init();
    const routes = adapter.getInstance();
    for (const url of ['/api/v1/genres', '/api/v1/tags', '/api/v1/tags/:id', '/api/v1/tags/browse', '/api/v1/tags/groups']) {
      expect(routes.hasRoute({ method: 'GET', url })).toBe(true);
    }
  } finally {
    await app.close();
  }
});
