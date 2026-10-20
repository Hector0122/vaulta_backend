import { parentPort, workerData } from 'worker_threads';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as exifr from 'exifr';
const req = createRequire(__filename);
const { computePerceptualHash } = req('../common/image-analysis');
const { THUMB_RESIZE, THUMB_QUALITY, LARGE_RESIZE, LARGE_QUALITY } = req(
  '../common/constants',
);

interface UploadWorkerInput {
  batchId: string;
  userId: string;
  files: { path: string; filename: string; mimeType: string; size: number }[];
  bucket: string;
  region: string;
  r2AccountId?: string;
}

async function run(input: UploadWorkerInput) {
  const { batchId, userId, files, bucket, region, r2AccountId } = input;
  const r2Endpoint = r2AccountId
    ? `https://${r2AccountId}.r2.cloudflarestorage.com`
    : undefined;
  const s3 = new S3Client({
    region: r2Endpoint ? 'auto' : region,
    endpoint: r2Endpoint,
    forcePathStyle: !!r2Endpoint,
    credentials: {
      accessKeyId:
        process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey:
        process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY!,
    },
    requestHandler: {
      requestTimeout: 300_000,
    },
  });
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL is required');
  const connectionString = rawUrl.includes('sslmode=')
    ? rawUrl
    : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}${
        rawUrl.includes('railway.internal')
          ? 'sslmode=disable'
          : 'sslmode=require'
      }`;
  const adapter = new PrismaPg(
    { connectionString },
    { schema: process.env.DATABASE_SCHEMA || 'public' },
  );
  const prisma = new PrismaClient({ adapter });
  const sharp = (await import('sharp')).default;

  let completed = 0;
  let failed = 0;
  let lastError = '';

  const sendProgress = (message: string) => {
    parentPort?.postMessage({
      type: 'progress',
      batchId,
      completed,
      failed,
      total: files.length,
      message,
    });
  };

  const MONTHS = [
    '01-Enero',
    '02-Febrero',
    '03-Marzo',
    '04-Abril',
    '05-Mayo',
    '06-Junio',
    '07-Julio',
    '08-Agosto',
    '09-Septiembre',
    '10-Octubre',
    '11-Noviembre',
    '12-Diciembre',
  ];

  function fmtDate(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${da}_${h}${mi}${s}`;
  }

  const CONCURRENCY = 5;
  const createdPhotoIds: string[] = [];
  const existingPhotoIds: string[] = [];

  async function processOne(file: (typeof files)[0]) {
    const buffer = fs.readFileSync(file.path);
    const contentHash = createHash('sha256').update(buffer).digest('hex');
    const existing = await prisma.photo.findFirst({
      where: { userId, contentHash, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      existingPhotoIds.push(existing.id);
      return;
    }
    const EXIF_DATE_TAGS = [
      'DateTimeOriginal',
      'CreateDate',
      'DateCreated',
      'ModifyDate',
    ];
    let photoDate: Date | null = null;
    const exifData = await exifr
      .parse(buffer, EXIF_DATE_TAGS)
      .catch(() => null);
    if (exifData) {
      for (const tag of EXIF_DATE_TAGS) {
        const d = exifData[tag];
        if (d) {
          photoDate = d;
          break;
        }
      }
    }
    if (photoDate) {
      const y = photoDate.getFullYear();
      if (y < 1900 || y > new Date().getFullYear() + 1) {
        photoDate = null;
      }
    }
    if (!photoDate) {
      const name = file.filename;
      const patterns: RegExp[] = [
        /(\d{4})-?(\d{2})-?(\d{2})/,
        /(\d{4})_(\d{2})(\d{2})/,
        /IMG[_-](\d{4})(\d{2})(\d{2})/i,
        /VID[_-](\d{4})(\d{2})(\d{2})/i,
      ];
      for (const p of patterns) {
        const m = name.match(p);
        if (m) {
          const y = parseInt(m[1], 10);
          const mo = parseInt(m[2], 10);
          const d = parseInt(m[3], 10);
          if (
            mo >= 1 &&
            mo <= 12 &&
            d >= 1 &&
            d <= 31 &&
            y >= 1900 &&
            y <= new Date().getFullYear() + 1
          ) {
            photoDate = new Date(y, mo - 1, d, 12, 0, 0);
            break;
          }
        }
      }
    }
    if (!photoDate) {
      photoDate = fs.statSync(file.path).mtime;
    }

    const year = photoDate.getFullYear();
    const month = MONTHS[photoDate.getMonth()];
    const dateStr = `${fmtDate(photoDate)}_${randomUUID().slice(0, 8)}`;

    const isVideo = file.mimeType.startsWith('video/');

    if (isVideo) {
      const ext = path.extname(file.filename).toLowerCase();
      const videoKey = `videos/${userId}/${year}/${month}/${dateStr}${ext}`;
      const thumbKey = `thumbs/${userId}/videos/${year}/${month}/${dateStr}.jpg`;
      const thumbPath = file.path + '-thumb.jpg';

      // Upload original video
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: videoKey,
          Body: buffer,
          ContentType: file.mimeType,
        }),
      );

      const url = r2Endpoint
        ? `${r2Endpoint}/${bucket}/${videoKey}`
        : `https://${bucket}.s3.${region}.amazonaws.com/${videoKey}`;

      let videoThumbKey: string | undefined;

      try {
        let ffmpegPath: string | null = null;
        try {
          const staticPath = req('ffmpeg-static');
          if (fs.existsSync(staticPath)) ffmpegPath = staticPath;
        } catch {
          /* fall through */
        }
        if (!ffmpegPath) {
          try {
            const { execSync } = await import('child_process');
            ffmpegPath = execSync('which ffmpeg', {
              encoding: 'utf8',
            }).trim();
          } catch {
            /* ffmpeg not on PATH */
          }
        }
        if (!ffmpegPath) {
          console.error(
            `[UploadWorker] ffmpeg not found, skipping thumbnail for ${file.filename}`,
          );
        } else {
          const ffmpeg = (await import('fluent-ffmpeg')).default;
          ffmpeg.setFfmpegPath(ffmpegPath);
          await new Promise<void>((resolve, reject) => {
            ffmpeg(file.path)
              .on('end', () => resolve())
              .on('error', reject)
              .screenshots({
                count: 1,
                timemarks: ['1'],
                filename: path.basename(thumbPath),
                folder: path.dirname(thumbPath),
                size: '300x?',
              });
          });
          const thumbBuffer = fs.readFileSync(thumbPath);
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: thumbKey,
              Body: thumbBuffer,
              ContentType: 'image/jpeg',
            }),
          );
          try {
            fs.unlinkSync(thumbPath);
          } catch {
            /* ignore */
          }
          videoThumbKey = thumbKey;
        }
      } catch (e) {
        console.error(
          `[UploadWorker] Thumbnail generation failed for ${file.filename}: ${(e as Error).message}`,
        );
      }

      const created = await prisma.photo.create({
        data: {
          s3Key: videoKey,
          thumbS3Key: videoThumbKey,
          url,
          filename: file.filename,
          mimeType: file.mimeType,
          size: file.size,
          createdAt: photoDate,
          contentHash,
          userId,
        },
      });
      createdPhotoIds.push(created.id);
    } else {
      const thumbKey = `thumbs/${userId}/fotos/${year}/${month}/${dateStr}.jpg`;
      const thumbBuffer = await sharp(buffer)
        .rotate()
        .resize(THUMB_RESIZE)
        .jpeg({ quality: THUMB_QUALITY })
        .toBuffer();

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: thumbKey,
          Body: thumbBuffer,
          ContentType: 'image/jpeg',
        }),
      );

      const largeKey = `fotos/${userId}/${year}/${month}/${dateStr}.jpg`;
      const largeBuffer = await sharp(buffer)
        .rotate()
        .resize(LARGE_RESIZE, LARGE_RESIZE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: LARGE_QUALITY })
        .toBuffer();

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: largeKey,
          Body: largeBuffer,
          ContentType: 'image/jpeg',
        }),
      );

      const url = r2Endpoint
        ? `${r2Endpoint}/${bucket}/${largeKey}`
        : `https://${bucket}.s3.${region}.amazonaws.com/${largeKey}`;

      const perceptualHash = await computePerceptualHash(buffer);

      const created = await prisma.photo.create({
        data: {
          s3Key: largeKey,
          thumbS3Key: thumbKey,
          largeS3Key: largeKey,
          url,
          filename: file.filename,
          mimeType: file.mimeType,
          size: file.size,
          perceptualHash,
          createdAt: photoDate,
          contentHash,
          userId,
        },
      });
      createdPhotoIds.push(created.id);
    }
  }

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      chunk.map(async (file) => {
        try {
          await processOne(file);
          completed++;
          sendProgress(`Subida ${completed} de ${files.length}`);
        } catch (err) {
          failed++;
          lastError = `${file.filename}: ${(err as Error).message}`;
          sendProgress(`Error: ${lastError}`);
        } finally {
          try {
            fs.unlinkSync(file.path);
          } catch {
            /* ignore */
          }
        }
      }),
    );
  }

  await prisma.$disconnect();

  parentPort?.postMessage({
    type: 'done',
    batchId,
    completed,
    failed,
    photoIds: createdPhotoIds,
    existingIds: existingPhotoIds,
    lastError,
    message: `Subida completada: ${completed} archivo(s) subido(s)${failed > 0 ? `, ${failed} fallaron: ${lastError}` : ''}`,
  });
}

run(workerData as UploadWorkerInput).catch((err: Error) => {
  parentPort?.postMessage({
    type: 'error',
    batchId: (workerData as UploadWorkerInput).batchId,
    message: err.message,
  });
});
