import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CoverMediumQueryDto, CoverReadQueryDto } from './cover-medium-query.dto';

describe('cover query DTOs', () => {
  it.each(['ebook', 'audio'])('accepts the %s medium', async (medium) => {
    await expect(validate(plainToInstance(CoverMediumQueryDto, { medium }))).resolves.toHaveLength(0);
  });

  it('rejects unknown media', async () => {
    await expect(validate(plainToInstance(CoverMediumQueryDto, { medium: 'print' }))).resolves.not.toHaveLength(0);
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('transforms strict=%s to %s', async (input, expected) => {
    const dto = plainToInstance(CoverReadQueryDto, { strict: input });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.strict).toBe(expected);
  });

  it.each(['true', 'false'])('accepts hideSensitive=%s with a cover medium under strict validation', async (value) => {
    const dto = plainToInstance(CoverReadQueryDto, { hideSensitive: value, medium: 'audio', t: '123' });
    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toHaveLength(0);
    expect(dto.hideSensitive).toBe(value === 'true');
  });

  it('rejects non-boolean privacy values', async () => {
    await expect(validate(plainToInstance(CoverReadQueryDto, { hideSensitive: 'yes' }))).resolves.not.toHaveLength(0);
  });

  it('rejects non-boolean strict values', async () => {
    await expect(validate(plainToInstance(CoverReadQueryDto, { strict: 'yes' }))).resolves.not.toHaveLength(0);
  });
});
