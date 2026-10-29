import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { EntityManagerService } from './entity-manager.service';
import { BrowseTagsDto } from './dto/browse-tags.dto';
import { BrowseTagGroupsDto } from './dto/entity-manager.dto';
@Controller('tags')
export class TagsController {
  constructor(private readonly service: EntityManagerService) {}
  @Get()
  browse(@Query() dto: BrowseTagsDto, @CurrentUser() user: RequestUser) {
    return this.service.browseTags(user, dto);
  }
  @Get('groups')
  groups(@Query() dto: BrowseTagGroupsDto, @CurrentUser() user: RequestUser) {
    return this.service.browseTagGroups(user, dto, true);
  }
}
