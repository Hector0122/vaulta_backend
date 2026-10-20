import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma.service';
import { S3_CLIENT, stableSigning } from '../common/s3.provider';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { FACE_DETECT_CONCURRENCY } from '../common/constants';

const MODELS_DIR = path.join(process.cwd(), 'models', 'face-api');
const MATCH_THRESHOLD = 0.45;
const MATCH_RATIO = 1.2;

export interface DetectedFace {
  encoding: number[];
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
}

type Box = { boxX: number; boxY: number; boxWidth: number; boxHeight: number };

/** True when two face boxes are the same face (intersection over union > 0.3). */
export function boxesOverlap(a: Box, b: Box): boolean {
  const w =
    Math.min(a.boxX + a.boxWidth, b.boxX + b.boxWidth) -
    Math.max(a.boxX, b.boxX);
  const h =
    Math.min(a.boxY + a.boxHeight, b.boxY + b.boxHeight) -
    Math.max(a.boxY, b.boxY);
  if (w <= 0 || h <= 0) return false;
  const inter = w * h;
  const union = a.boxWidth * a.boxHeight + b.boxWidth * b.boxHeight - inter;
  return inter / union > 0.3;
}

@Injectable()
export class FacesService implements OnModuleInit {
  private readonly logger = new Logger(FacesService.name);
  private _ready = false;
  private _error = '';

  constructor(
    private prisma: PrismaService,
    @Inject(S3_CLIENT) private s3: S3Client,
  ) {}

  onModuleInit() {
    try {
      this.ensureModelsExist();
      this._ready = true;
      this.logger.log('Face detection models verified on disk');
    } catch (err) {
      this._error = (err as Error).message;
      this.logger.warn(
        `Face detection models not available: ${this._error}. Face features disabled.`,
      );
    }
  }

  get ready(): boolean {
    return this._ready;
  }

  get lastError(): string {
    return this._error;
  }

  private ensureModelsExist() {
    if (!fs.existsSync(MODELS_DIR)) {
      throw new Error(`Models directory not found: ${MODELS_DIR}`);
    }
    const required = [
      'tiny_face_detector_model.bin',
      'face_landmark_68_model.bin',
      'face_recognition_model.bin',
    ];
    const missing = required.filter(
      (f) => !fs.existsSync(path.join(MODELS_DIR, f)),
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing face model files: ${missing.join(', ')} in ${MODELS_DIR}`,
      );
    }
  }

  private async getImageBuffer(s3Key: string): Promise<Buffer> {
    const bucket =
      process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';

    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: s3Key }),
    );

    const chunks: Uint8Array[] = [];
    if (!response.Body) throw new Error('Empty response from S3');
    const stream = response.Body as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    return Buffer.concat(chunks);
  }

  private resolveScriptPath(): string {
    const candidates = [
      path.join(__dirname, '..', '..', 'faces', 'face-detect.mjs'),
      path.join(process.cwd(), 'dist', 'faces', 'face-detect.mjs'),
      path.join(process.cwd(), 'src', 'faces', 'face-detect.mjs'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[0];
  }

  private runDetection(imagePath: string): Promise<DetectedFace[]> {
    return new Promise((resolve, reject) => {
      const scriptPath = this.resolveScriptPath();

      const proc = spawn('node', [scriptPath, imagePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        reject(
          new Error(`spawn error: ${err.message}, scriptPath: ${scriptPath}`),
        );
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          this.logger.warn(
            `face-detect.mjs exited with code ${code}: ${stderr}, scriptPath: ${scriptPath}`,
          );
        }
        try {
          const result = JSON.parse(stdout);
          resolve(result.faces || []);
        } catch {
          reject(new Error(`parse error (code ${code}): ${stderr}`));
        }
      });
    });
  }

  async detectFaces(photoId: string, userId: string): Promise<DetectedFace[]> {
    if (!this._ready) {
      this.logger.warn('Face detection not ready, skipping');
      return [];
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { s3Key: true, mimeType: true, userId: true, private: true },
    });

    if (!photo || photo.userId !== userId) {
      throw new Error('Photo not found');
    }

    if (photo.private) {
      return [];
    }

    const isVideo = photo.mimeType.startsWith('video/');
    if (isVideo) {
      return [];
    }

    const tmpDir = path.join(os.tmpdir(), 'vaulta-faces');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const tmpFile = path.join(
      tmpDir,
      `${photoId}${path.extname(photo.s3Key) || '.jpg'}`,
    );

    try {
      const buffer = await this.getImageBuffer(photo.s3Key);
      fs.writeFileSync(tmpFile, buffer);

      const faces = await this.runDetection(tmpFile);

      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }

      return faces;
    } catch (err) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      this.logger.error(
        `Face detection failed for photo ${photoId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  private markScanned(photoId: string) {
    return this.prisma.photo.update({
      where: { id: photoId },
      data: { facesScannedAt: new Date() },
    });
  }

  async detectAndSave(photoId: string, userId: string): Promise<number> {
    const faces = await this.detectFaces(photoId, userId);

    if (faces.length === 0) {
      await this.markScanned(photoId);
      return 0;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.face.deleteMany({ where: { photoId } });
      await tx.photo.update({
        where: { id: photoId },
        data: { facesScannedAt: new Date() },
      });

      await tx.face.createMany({
        data: faces.map((f) => ({
          photoId,
          encoding: f.encoding,
          boxX: f.boxX,
          boxY: f.boxY,
          boxWidth: f.boxWidth,
          boxHeight: f.boxHeight,
        })),
      });

      const allExisting = await tx.face.findMany({
        where: {
          personName: { not: null },
          confirmed: true,
          photo: { userId },
        },
        select: { personName: true, encoding: true },
      });

      const personEncodings = new Map<string, number[][]>();
      for (const ef of allExisting) {
        if (!ef.personName) continue;
        const encs = personEncodings.get(ef.personName) || [];
        encs.push(ef.encoding as number[]);
        personEncodings.set(ef.personName, encs);
      }

      if (personEncodings.size > 0) {
        const newFaces = await tx.face.findMany({
          where: { photoId, personName: null, ignored: false },
        });

        for (const face of newFaces) {
          const encoding = face.encoding as number[];
          const scores: { name: string; avgDist: number }[] = [];

          for (const [name, encs] of personEncodings) {
            let sum = 0;
            for (const refEnc of encs) {
              sum += this.euclideanDistance(encoding, refEnc);
            }
            scores.push({ name, avgDist: sum / encs.length });
          }

          scores.sort((a, b) => a.avgDist - b.avgDist);

          if (scores.length === 0) continue;
          const best = scores[0];
          if (best.avgDist >= MATCH_THRESHOLD) continue;

          if (scores.length >= 2) {
            const second = scores[1];
            if (second.avgDist / best.avgDist < MATCH_RATIO) continue;
          }

          await tx.face.update({
            where: { id: face.id },
            data: { personName: best.name, confirmed: true },
          });
        }
      }
    });

    return faces.length;
  }

  async detectBatch(
    userId: string,
    photoIds: string[],
  ): Promise<{ processed: number; facesFound: number; failed: number }> {
    let processed = 0;
    let facesFound = 0;
    let failed = 0;

    for (let i = 0; i < photoIds.length; i += FACE_DETECT_CONCURRENCY) {
      const chunk = photoIds.slice(i, i + FACE_DETECT_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async (photoId) => {
          const count = await this.detectAndSave(photoId, userId);
          return { photoId, count };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          processed++;
          facesFound += result.value.count;
        } else {
          this.logger.error(`Failed to detect faces: ${result.reason}`);
          failed++;
        }
      }
    }

    return { processed, facesFound, failed };
  }

  async getDetectStatus(
    userId: string,
  ): Promise<{ total: number; pending: number; detected: number }> {
    const photos = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        mimeType: { not: { startsWith: 'video/' } },
      },
      select: { facesScannedAt: true },
    });
    const total = photos.length;
    const detected = photos.filter((p) => p.facesScannedAt).length;
    return { total, pending: total - detected, detected };
  }

  async getPendingPhotos(
    userId: string,
    take = 50,
    cursor?: string,
    page?: number,
  ): Promise<{
    photos: { id: string; s3Key: string }[];
    nextCursor: string | null;
  }> {
    const skip = page ? (page - 1) * take : undefined;
    const photos = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        private: false,
        mimeType: { startsWith: 'image/' },
        facesScannedAt: null,
      },
      select: { id: true, s3Key: true },
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      ...(skip !== undefined ? { skip } : {}),
      orderBy: { createdAt: 'asc' },
    });

    const hasMore = photos.length > take;
    if (hasMore) photos.pop();

    const nextCursor = hasMore ? photos[photos.length - 1].id : null;

    return { photos, nextCursor };
  }

  async getConfirmedEncodings(
    userId: string,
  ): Promise<{ people: { personName: string; encodings: number[][] }[] }> {
    const faces = await this.prisma.face.findMany({
      where: {
        photo: { userId, deletedAt: null, private: false },
        personName: { not: null },
        confirmed: true,
        ignored: false,
      },
      select: { personName: true, encoding: true },
    });

    const grouped = new Map<string, number[][]>();
    for (const f of faces) {
      if (!f.personName) continue;
      const encs = grouped.get(f.personName) || [];
      encs.push(f.encoding as number[]);
      grouped.set(f.personName, encs);
    }

    const people = Array.from(grouped.entries()).map(
      ([personName, encodings]) => ({
        personName,
        encodings,
      }),
    );

    return { people };
  }

  async ingestResults(
    userId: string,
    results: Array<{
      photoId: string;
      faces: Array<{
        encoding: number[];
        boxX: number;
        boxY: number;
        boxWidth: number;
        boxHeight: number;
        personName?: string;
      }>;
    }>,
  ): Promise<{ processed: number; facesFound: number }> {
    let processed = 0;
    let facesFound = 0;

    for (const result of results) {
      await this.prisma.$transaction(async (tx) => {
        const photo = await tx.photo.findUnique({
          where: { id: result.photoId },
          select: { userId: true, private: true },
        });
        if (!photo || photo.userId !== userId || photo.private) return;

        // A rescan replaces only untouched detections: faces the user named,
        // confirmed or ignored stay, and new detections on top of them are dropped.
        const isUntouched = {
          personName: null,
          confirmed: false,
          ignored: false,
        };
        await tx.face.deleteMany({
          where: { photoId: result.photoId, ...isUntouched },
        });
        const kept = await tx.face.findMany({
          where: { photoId: result.photoId },
          select: { boxX: true, boxY: true, boxWidth: true, boxHeight: true },
        });
        await tx.photo.update({
          where: { id: result.photoId },
          data: { facesScannedAt: new Date() },
        });
        processed++;

        const newFaces = result.faces.filter(
          (f) => !kept.some((k) => boxesOverlap(f, k)),
        );
        if (newFaces.length === 0) return;

        await tx.face.createMany({
          data: newFaces.map((f) => ({
            photoId: result.photoId,
            encoding: f.encoding,
            boxX: f.boxX,
            boxY: f.boxY,
            boxWidth: f.boxWidth,
            boxHeight: f.boxHeight,
            personName: f.personName || null,
            confirmed: !!f.personName,
          })),
        });

        facesFound += newFaces.length;
      });
    }

    return { processed, facesFound };
  }

  async getPeople(userId: string): Promise<
    {
      name: string;
      faceCount: number;
      photoCount: number;
      thumbnailPhotoId: string | null;
      thumbnailUri: string | null;
    }[]
  > {
    const faces = await this.prisma.face.findMany({
      where: {
        photo: { userId, deletedAt: null, private: false },
        personName: { not: null },
        confirmed: true,
        ignored: false,
      },
      select: {
        personName: true,
        photoId: true,
        photo: { select: { id: true, thumbS3Key: true, s3Key: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byPerson = new Map<
      string,
      {
        faceCount: number;
        photoIds: Set<string>;
        firstPhoto: (typeof faces)[0]['photo'] | null;
      }
    >();

    for (const f of faces) {
      if (!f.personName) continue;
      let entry = byPerson.get(f.personName);
      if (!entry) {
        entry = { faceCount: 0, photoIds: new Set(), firstPhoto: null };
        byPerson.set(f.personName, entry);
      }
      entry.faceCount++;
      entry.photoIds.add(f.photoId);
      if (!entry.firstPhoto) entry.firstPhoto = f.photo;
    }

    const bucket =
      process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    return Promise.all(
      Array.from(byPerson.entries()).map(async ([name, data]) => {
        let thumbnailUri: string | null = null;
        if (data.firstPhoto) {
          const thumbKey = data.firstPhoto.thumbS3Key || data.firstPhoto.s3Key;
          thumbnailUri = await getSignedUrl(
            this.s3,
            new GetObjectCommand({ Bucket: bucket, Key: thumbKey }),
            stableSigning(),
          );
        }
        return {
          name,
          faceCount: data.faceCount,
          photoCount: data.photoIds.size,
          thumbnailPhotoId: data.firstPhoto?.id ?? null,
          thumbnailUri,
        };
      }),
    ).then((results) => results.sort((a, b) => b.photoCount - a.photoCount));
  }

  async getUnconfirmed(userId: string): Promise<
    {
      id: string;
      photoId: string;
      photoUri: string | null;
      suggestions: { personName: string; distance: number }[];
    }[]
  > {
    const faces = await this.prisma.face.findMany({
      where: {
        photo: { userId, deletedAt: null, private: false },
        confirmed: false,
        ignored: false,
      },
      select: {
        id: true,
        photoId: true,
        encoding: true,
        photo: { select: { id: true, thumbS3Key: true, s3Key: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const confirmedFaces = await this.prisma.face.findMany({
      where: {
        photo: { userId, deletedAt: null, private: false },
        personName: { not: null },
        confirmed: true,
        ignored: false,
      },
      select: { personName: true, encoding: true },
      take: 2000,
    });

    const personEncodings = new Map<string, number[][]>();
    for (const f of confirmedFaces) {
      if (!f.personName) continue;
      const encs = personEncodings.get(f.personName) || [];
      encs.push(f.encoding as number[]);
      personEncodings.set(f.personName, encs);
    }

    const bucket =
      process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';

    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const results = await Promise.all(
      faces.map(async (f) => {
        const encoding = f.encoding as number[];
        const allSuggestions: { personName: string; distance: number }[] = [];

        for (const [name, encs] of personEncodings) {
          let sum = 0;
          for (const refEnc of encs) {
            sum += this.euclideanDistance(encoding, refEnc);
          }
          const avgDist = sum / encs.length;
          if (avgDist < MATCH_THRESHOLD) {
            allSuggestions.push({ personName: name, distance: avgDist });
          }
        }

        allSuggestions.sort((a, b) => a.distance - b.distance);
        const suggestions = allSuggestions.slice(0, 3);

        const thumbKey = f.photo.thumbS3Key || f.photo.s3Key;
        const uri = await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: bucket, Key: thumbKey }),
          stableSigning(),
        );
        return { id: f.id, photoId: f.photoId, photoUri: uri, suggestions };
      }),
    );

    return results;
  }

  async getPhotosByPerson(
    userId: string,
    personName: string,
    cursor?: string,
    maxKeys = 50,
  ): Promise<{ photos: any[]; nextToken: string | null }> {
    const facePhotoIds = await this.prisma.face.findMany({
      where: {
        photo: { userId, deletedAt: null, private: false },
        personName,
        confirmed: true,
        ignored: false,
      },
      select: { photoId: true },
      distinct: ['photoId'],
    });

    const photoIds = facePhotoIds.map((f) => f.photoId);

    if (photoIds.length === 0) return { photos: [], nextToken: null };

    const dbPhotos = await this.prisma.photo.findMany({
      where: { id: { in: photoIds } },
      take: maxKeys,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: 'desc' },
    });

    const bucket =
      process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const results = await Promise.all(
      dbPhotos.map(async (photo) => {
        const thumbKey = photo.thumbS3Key || photo.s3Key;
        const uri = await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: bucket, Key: thumbKey }),
          stableSigning(),
        );
        return {
          uri,
          date: photo.createdAt.toISOString().slice(0, 10),
          id: photo.id,
          favorite: photo.favorite,
          tags: photo.tags,
          blurred: photo.blurred,
          private: photo.private,
          mimeType: photo.mimeType,
        };
      }),
    );

    const nextToken =
      dbPhotos.length === maxKeys ? dbPhotos[dbPhotos.length - 1].id : null;

    return { photos: results, nextToken };
  }

  async updateFace(
    faceId: string,
    userId: string,
    data: { personName?: string; confirmed?: boolean; ignored?: boolean },
  ) {
    const face = await this.prisma.face.findUnique({
      where: { id: faceId },
      select: { id: true, photo: { select: { userId: true, id: true } } },
    });

    if (!face || face.photo.userId !== userId) return null;

    const updated = await this.prisma.face.update({
      where: { id: faceId },
      data: {
        ...(data.personName !== undefined
          ? { personName: data.personName }
          : {}),
        ...(data.confirmed !== undefined ? { confirmed: data.confirmed } : {}),
        ...(data.ignored !== undefined ? { ignored: data.ignored } : {}),
      },
    });

    let suggestedTag: string | null = null;
    if (data.confirmed && data.personName) {
      const photo = await this.prisma.photo.findUnique({
        where: { id: face.photo.id },
        select: { tags: true },
      });
      const normalized = data.personName.trim().toLowerCase();
      if (photo && !photo.tags.includes(normalized)) {
        suggestedTag = normalized;
      }
    }

    return { ...updated, suggestedTag };
  }

  async deleteFacesByPhoto(
    photoId: string,
    userId: string,
    personName?: string,
  ) {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { userId: true },
    });

    if (!photo || photo.userId !== userId) throw new Error('Photo not found');

    const where: any = { photoId };
    if (personName) where.personName = personName;

    const { count } = await this.prisma.face.deleteMany({ where });
    return { deleted: count };
  }

  async mergePeople(
    userId: string,
    fromPerson: string,
    toPerson: string,
  ): Promise<number> {
    const result = await this.prisma.face.updateMany({
      where: {
        photo: { userId },
        personName: fromPerson,
      },
      data: { personName: toPerson },
    });

    return result.count;
  }

  async findMoreFaces(
    userId: string,
    personName: string,
  ): Promise<
    { faceId: string; photoId: string; photoUri: string; distance: number }[]
  > {
    const confirmedFaces = await this.prisma.face.findMany({
      where: {
        photo: { userId, deletedAt: null, private: false },
        personName,
        confirmed: true,
        ignored: false,
      },
      select: { encoding: true },
      take: 20,
    });

    if (confirmedFaces.length === 0) return [];

    const confirmedEncodings = confirmedFaces.map(
      (f) => f.encoding as number[],
    );

    const BATCH_SIZE = 500;
    let skip = 0;
    let hasMore = true;

    interface ScoredFace {
      id: string;
      photoId: string;
      photo: { thumbS3Key: string | null; s3Key: string };
      distance: number;
    }
    const allMatches: ScoredFace[] = [];

    const bucket =
      process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET || '';

    while (hasMore) {
      const batch = await this.prisma.face.findMany({
        where: {
          photo: { userId, deletedAt: null, private: false },
          confirmed: false,
          ignored: false,
          personName: null,
        },
        select: {
          id: true,
          photoId: true,
          encoding: true,
          photo: { select: { thumbS3Key: true, s3Key: true } },
        },
        skip,
        take: BATCH_SIZE,
      });

      if (batch.length === 0) {
        hasMore = false;
        break;
      }
      skip += batch.length;

      const unconfirmedEncodings = batch.map((f) => f.encoding as number[]);

      const matches = await this.runFindMoreWorker(
        confirmedEncodings,
        unconfirmedEncodings,
        MATCH_THRESHOLD,
      );

      for (const m of matches) {
        const face = batch[m.index];
        allMatches.push({
          id: face.id,
          photoId: face.photoId,
          photo: face.photo,
          distance: m.distance,
        });
      }
    }

    allMatches.sort((a, b) => a.distance - b.distance);

    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    return Promise.all(
      allMatches.map(async (m) => {
        const thumbKey = m.photo.thumbS3Key || m.photo.s3Key;
        const uri = await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: bucket, Key: thumbKey }),
          stableSigning(),
        );
        return {
          faceId: m.id,
          photoId: m.photoId,
          photoUri: uri,
          distance: m.distance,
        };
      }),
    );
  }

  private runFindMoreWorker(
    confirmedEncodings: number[][],
    unconfirmedEncodings: number[][],
    threshold: number,
  ): Promise<{ index: number; distance: number }[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'find-more.worker.js'), {
        workerData: { confirmedEncodings, unconfirmedEncodings, threshold },
      });
      worker.on('message', (msg) => {
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg);
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
      });
    });
  }

  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      sum += (a[i] - b[i]) ** 2;
    }
    return Math.sqrt(sum);
  }

  async cleanupPrivateFaces(userId: string): Promise<{ deleted: number }> {
    const result = await this.prisma.face.deleteMany({
      where: {
        photo: { userId, private: true },
      },
    });
    return { deleted: result.count };
  }
}
