import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Permission } from '@bookorbit/types';
import type { FastifyReply } from 'fastify';
import type { RequestUser } from '../../common/types/request-user';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { RevisionDownloadController } from './revision-download.controller';
import { RevisionDownloadApiService } from './revision-download-api.service';
import { expect, it, vi } from 'vitest';

it('exposes verified revision headers and cancels streaming when the response closes', async () => {
  const stream = Readable.from([Buffer.from('EPUB')]);
  const service = { download: vi.fn().mockResolvedValue({ stream, sizeBytes: 4, sha256: 'a'.repeat(64), revisionId: 'revision' }) };
  const module = await Test.createTestingModule({
    providers: [RevisionDownloadController, { provide: RevisionDownloadApiService, useValue: service }],
  }).compile();
  const controller = module.get(RevisionDownloadController);
  const raw = Object.assign(new EventEmitter(), { destroyed: false });
  const reply = { raw, header: vi.fn(), send: vi.fn() };
  const user = { id: 1 } as RequestUser;
  await controller.download(2, 3, 'revision', user, reply as unknown as FastifyReply);
  expect(Reflect.getMetadata(PERMISSION_KEY, RevisionDownloadController.prototype.download)).toBe(Permission.LibraryDownload);
  expect(reply.header).toHaveBeenCalledWith('Content-Length', 4);
  expect(reply.header).toHaveBeenCalledWith('X-BookOrbit-Revision', 'revision');
  expect(reply.header).toHaveBeenCalledWith('X-BookOrbit-SHA256', 'a'.repeat(64));
  expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  expect(reply.send).toHaveBeenCalledWith(stream);
  const cancelled = service.download.mock.calls[0][4];
  expect(cancelled()).toBe(false);
  raw.destroyed = true;
  raw.emit('close');
  expect(cancelled()).toBe(true);
  expect(stream.destroyed).toBe(true);
});
