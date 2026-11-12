import sharp from 'sharp';

export async function blurSensitiveCover(path: string): Promise<Buffer> {
  // Discard detail before blurring so protected responses never contain the original artwork.
  return sharp(path).rotate().resize({ width: 16, height: 16, fit: 'inside' }).blur(5).jpeg({ quality: 70 }).toBuffer();
}
