import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BrowseEntitiesDto, BrowseTagGroupsDto } from './entity-manager.dto';
import { UpdateTagGroupingDto } from '../../user/dto/update-tag-grouping.dto';

describe('tag grouping validation', () => {
  it.each(['.', '/', '-', '::', '%_', '→'])('accepts literal separator %s', async (separator) => {
    expect(await validate(plainToInstance(BrowseTagGroupsDto, { separator, page: '2', pageSize: '20' }))).toEqual([]);
    expect(await validate(plainToInstance(UpdateTagGroupingDto, { separator, enabled: true }))).toEqual([]);
    expect(await validate(plainToInstance(BrowseEntitiesDto, { tagSeparator: separator, tagPrefix: '' }))).toEqual([]);
  });
  it.each(['', ' ', '\n', '123456789', 'a b', '\0'])('rejects invalid separator %j', async (separator) => {
    expect(await validate(plainToInstance(BrowseTagGroupsDto, { separator }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(UpdateTagGroupingDto, { separator, enabled: true }))).not.toHaveLength(0);
  });
  it.each([{ page: 0 }, { page: 1.5 }, { pageSize: 101 }, { pageSize: -1 }, { page: 'NaN' }])('bounds group pagination %j', async (params) => {
    expect(await validate(plainToInstance(BrowseTagGroupsDto, { separator: '.', ...params }))).not.toHaveLength(0);
  });
  it('requires a boolean grouping preference', async () => {
    expect(await validate(plainToInstance(UpdateTagGroupingDto, { separator: '.', enabled: 'yes' }))).not.toHaveLength(0);
  });
});
