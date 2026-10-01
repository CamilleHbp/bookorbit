import { Test } from '@nestjs/testing';
import { Permission, EMPTY_CONTENT_FILTER_RULES } from '@bookorbit/types';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { TagsController } from './tags.controller';
import { EntityManagerController } from './entity-manager.controller';
import { EntityManagerService } from './entity-manager.service';
import { UserController } from '../user/user.controller';
import { UserService } from '../user/user.service';
import { UserAvatarService } from '../user/user-avatar.service';

describe('tag grouping controller contracts', () => {
  it('requires metadata editing and passes the authenticated user into group discovery', async () => {
    const service = { browseTagGroups: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }) };
    const module = await Test.createTestingModule({
      controllers: [EntityManagerController],
      providers: [{ provide: EntityManagerService, useValue: service }],
    }).compile();
    const controller = module.get(EntityManagerController);
    const user = {
      id: 7,
      username: 'reader',
      isSuperuser: false,
      permissions: [Permission.LibraryEditMetadata],
      contentFilters: EMPTY_CONTENT_FILTER_RULES,
    };
    await controller.browseTagGroups({ separator: '/', page: 2 }, user);
    expect(service.browseTagGroups).toHaveBeenCalledWith(user, { separator: '/', page: 2 });
    expect(Reflect.getMetadata(PERMISSION_KEY, controller.browseTagGroups)).toBe(Permission.LibraryEditMetadata);
    await module.close();
  });

  it('allows readers to discover scoped tags without metadata-edit permission', async () => {
    const service = { browseTags: vi.fn().mockResolvedValue({}), browseTagGroups: vi.fn().mockResolvedValue({}) };
    const module = await Test.createTestingModule({
      controllers: [TagsController],
      providers: [{ provide: EntityManagerService, useValue: service }],
    }).compile();
    const controller = module.get(TagsController);
    const user = { id: 7, username: 'reader', isSuperuser: false, permissions: [], contentFilters: EMPTY_CONTENT_FILTER_RULES };
    await controller.browse({ tagSeparator: '.', tagPrefix: 'fandom', page: 2 }, user);
    await controller.groups({ separator: '.' }, user);
    expect(service.browseTags).toHaveBeenCalledWith(user, { tagSeparator: '.', tagPrefix: 'fandom', page: 2 });
    expect(service.browseTagGroups).toHaveBeenCalledWith(user, { separator: '.' }, true);
    expect(Reflect.getMetadata(PERMISSION_KEY, controller.browse)).toBeUndefined();
    await module.close();
  });

  it('saves preferences only for the authenticated account', async () => {
    const service = { updateMySettings: vi.fn().mockResolvedValue({}) };
    const module = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: service },
        { provide: UserAvatarService, useValue: {} },
      ],
    }).compile();
    const controller = module.get(UserController);
    const user = {
      id: 7,
      username: 'reader',
      isSuperuser: false,
      permissions: [Permission.LibraryEditMetadata],
      contentFilters: EMPTY_CONTENT_FILTER_RULES,
    };
    await controller.updateTagGrouping(user, { separator: '::', enabled: true });
    expect(service.updateMySettings).toHaveBeenCalledWith(7, { settings: { tagGrouping: { separator: '::', enabled: true } } });
    expect(Reflect.getMetadata(PERMISSION_KEY, controller.updateTagGrouping)).toBeUndefined();
    await module.close();
  });
});
