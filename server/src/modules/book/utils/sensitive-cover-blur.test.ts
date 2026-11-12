import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { blurSensitiveCover } from './sensitive-cover-blur';

it('reduces artwork to a tiny blurred image without preserving sharp detail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookorbit-blur-'));
  try {
    const width = 300;
    const height = 450;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0 ? 255 : 0;
        pixels.fill(value, (y * width + x) * 3, (y * width + x + 1) * 3);
      }
    }
    const path = join(dir, 'cover.png');
    await writeFile(
      path,
      await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const blurred = await blurSensitiveCover(path);
    expect(await sharp(blurred).metadata()).toMatchObject({ format: 'jpeg', width: 11, height: 16 });
    const stats = await sharp(blurred).stats();
    expect(stats.channels.every((channel) => channel.stdev < 5)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
