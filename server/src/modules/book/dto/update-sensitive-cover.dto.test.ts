import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@bookorbit/types';
import { PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator';
import { BookController } from '../book.controller';
import { BookService } from '../book.service';
import { FileWriteService } from '../../file-write/file-write.service';
import { UpdateSensitiveCoverDto } from './update-sensitive-cover.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const metadata = { type: 'body' as const, metatype: UpdateSensitiveCoverDto };

describe('sensitive cover API contract', () => {
  it.each([{}, { sensitiveCover: 'true' }, { sensitiveCover: 1 }, { sensitiveCover: null }, { sensitiveCover: true, userId: 2 }])(
    'rejects invalid input %j',
    async (body) => {
      await expect(pipe.transform(body, metadata)).rejects.toThrow(BadRequestException);
    },
  );
  it.each([true, false])('accepts and forwards %s with the authenticated user', async (sensitiveCover) => {
    const updateSensitiveCover = vi.fn();
    const module = await Test.createTestingModule({
      controllers: [BookController],
      providers: [
        { provide: BookService, useValue: { updateSensitiveCover } },
        { provide: FileWriteService, useValue: {} },
      ],
    }).compile();
    const controller = module.get(BookController);
    const dto = await pipe.transform({ sensitiveCover }, metadata);
    const user = { id: 3 } as never;
    await controller.updateSensitiveCover(7, dto, user);
    expect(updateSensitiveCover).toHaveBeenCalledWith(7, sensitiveCover, user);
    expect(Reflect.getMetadata(PERMISSION_KEY, BookController.prototype.updateSensitiveCover)).toBe(Permission.LibraryEditMetadata);
    await module.close();
  });
});
