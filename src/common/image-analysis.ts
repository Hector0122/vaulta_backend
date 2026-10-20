import sharp from 'sharp';

export async function computePerceptualHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(8, 8, { fit: 'cover' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  const hash = Array.from(data)
    .map((v) => (v > avg ? '1' : '0'))
    .join('');
  return BigInt('0b' + hash)
    .toString(16)
    .padStart(16, '0');
}
