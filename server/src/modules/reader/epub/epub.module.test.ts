import 'reflect-metadata';

vi.mock('../../book/book.module', () => ({ BookModule: class BookModule {} }));
vi.mock('../../library/library.module', () => ({ LibraryModule: class LibraryModule {} }));

import { BookModule } from '../../book/book.module';
import { LibraryModule } from '../../library/library.module';
import { EpubController } from './epub.controller';
import { EpubModule } from './epub.module';
import { EpubService } from './epub.service';
import { BookRevisionModule } from '../../book-revision/book-revision.module';
import { UserModule } from '../../user/user.module';
import { EpubRevisionController } from './epub-revision.controller';
import { EpubRevisionService } from './epub-revision.service';

describe('EpubModule', () => {
  it('registers expected imports/controllers/providers', () => {
    expect(Reflect.getMetadata('imports', EpubModule)).toEqual([BookModule, LibraryModule, BookRevisionModule, UserModule]);
    expect(Reflect.getMetadata('controllers', EpubModule)).toEqual([EpubController, EpubRevisionController]);
    expect(Reflect.getMetadata('providers', EpubModule)).toEqual([EpubService, EpubRevisionService]);
  });
});
