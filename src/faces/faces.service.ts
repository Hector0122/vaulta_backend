import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma.service';
import { S3_CLIENT, stableSigning } from '../common/s3.provider';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  FACE_DETECT_CONCURRENCY,
  FACE_DETECT_DEFAULT_LIMIT,
  FACE_DETECT_MAX_LIMIT,
} from '../common/constants';

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

@Injectable()
export class FacesService implements OnModuleInit {
  private readonly logger = new Logger(FacesService.name);
  private _ready = false;
  private _error = '';

  private scanJobs = new Map<
    string,
    {
      status: 'running' | 'completed' | 'stopped';
      total: number;
      processed: number;
      facesFound: number;
      failed: number;
      worker?: Worker;
      userId: string;
    }
  >();

  private activeScanUsers = new Set<string>();

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

  private runDetection(
    imagePath: string,
  ): Promise<{ faces: DetectedFace[]; stderr: string }> {
    return new Promise((resolve) => {
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
        resolve({
          faces: [],
          stderr: `spawn error: ${err.message}, scriptPath: ${scriptPath}`,
        });
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          this.logger.warn(
            `face-detect.mjs exited with code ${code}: ${stderr}, scriptPath: ${scriptPath}`,
          );
        }
        try {
          const result = JSON.parse(stdout);
          resolve({ faces: result.faces || [], stderr });
        } catch {
          resolve({
            faces: [],
            stderr: `parse error (code ${code}): ${stderr}`,
          });
        }
      });
    });
  }

  async detectFacesWithDebug(
    photoId: string,
    userId: string,
  ): Promise<{ faces: DetectedFace[]; stderr: string; ready: boolean }> {
    if (!this._ready) {
      return { faces: [], stderr: `Not ready: ${this._error}`, ready: false };
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { s3Key: true, mimeType: true, userId: true },
    });

    if (!photo || photo.userId !== userId) {
      return { faces: [], stderr: 'Photo not found', ready: this._ready };
    }

    if (photo.mimeType.startsWith('video/')) {
      return { faces: [], stderr: 'Video, skipping', ready: this._ready };
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

      const result = await this.runDetection(tmpFile);

      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }

      return { faces: result.faces, stderr: result.stderr, ready: this._ready };
    } catch (err) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      return {
        faces: [],
        stderr: `Error: ${(err as Error).message}`,
        ready: this._ready,
      };
    }
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

      const { faces } = await this.runDetection(tmpFile);

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
      return [];
    }
  }

  async detectAndSave(photoId: string, userId: string): Promise<number> {
    const faces = await this.detectFaces(photoId, userId);

    if (faces.length === 0) return 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.face.deleteMany({ where: { photoId } });

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

  async detectAll(
    userId: string,
    limit?: number,
  ): Promise<{ jobId: string; total: number; status: string }> {
    if (this.activeScanUsers.has(userId)) {
      return { jobId: '', total: 0, status: 'already_running' };
    }

    let effectiveLimit = limit ?? FACE_DETECT_DEFAULT_LIMIT;
    if (effectiveLimit < 1) effectiveLimit = FACE_DETECT_DEFAULT_LIMIT;
    if (effectiveLimit > FACE_DETECT_MAX_LIMIT)
      effectiveLimit = FACE_DETECT_MAX_LIMIT;

    const photos = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        private: false,
        mimeType: { not: { startsWith: 'video/' } },
      },
      select: { id: true, _count: { select: { faces: true } } },
    });

    let photoIds = photos.filter((p) => p._count.faces === 0).map((p) => p.id);

    if (photoIds.length > effectiveLimit) {
      photoIds = photoIds.slice(0, effectiveLimit);
    }

    if (photoIds.length === 0) {
      return { jobId: '', total: 0, status: 'nothing_to_scan' };
    }

    const jobId = `scan_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.scanJobs.set(jobId, {
      status: 'running',
      total: photoIds.length,
      processed: 0,
      facesFound: 0,
      failed: 0,
      userId,
    });
    this.activeScanUsers.add(userId);

    const releaseLock = () => {
      this.activeScanUsers.delete(userId);
    };

    const worker = new Worker(path.join(__dirname, 'detect-all.worker.js'), {
      workerData: { userId, photoIds, concurrency: FACE_DETECT_CONCURRENCY },
    });

    const job = this.scanJobs.get(jobId)!;
    job.worker = worker;

    worker.on('message', (msg: any) => {
      const j = this.scanJobs.get(jobId);
      if (!j) return;
      if (msg.type === 'progress') {
        j.processed = msg.processed;
        j.facesFound = msg.facesFound;
        j.failed = msg.failed;
      } else if (msg.type === 'done') {
        j.status = 'completed';
        j.processed = msg.processed;
        j.facesFound = msg.facesFound;
        j.failed = msg.failed;
        j.worker = undefined;
        releaseLock();
      } else if (msg.type === 'error') {
        this.logger.error(`Scan worker error: ${msg.message}`);
        if (msg.stack) this.logger.error(msg.stack);
        j.status = 'stopped';
        j.worker = undefined;
        releaseLock();
      }
    });

    worker.on('error', () => {
      const j = this.scanJobs.get(jobId);
      if (j) {
        j.status = 'stopped';
        j.worker = undefined;
        releaseLock();
      }
    });

    worker.on('exit', () => {
      const j = this.scanJobs.get(jobId);
      if (j && j.status === 'running') {
        j.status = 'stopped';
        j.worker = undefined;
        releaseLock();
      }
    });

    return { jobId, total: photoIds.length, status: 'started' };
  }

  getDetectProgress(jobId: string): {
    status: string;
    total: number;
    processed: number;
    facesFound: number;
    failed: number;
  } | null {
    const job = this.scanJobs.get(jobId);
    if (!job) return null;
    return {
      status: job.status,
      total: job.total,
      processed: job.processed,
      facesFound: job.facesFound,
      failed: job.failed,
    };
  }

  stopDetectAll(jobId: string): boolean {
    const job = this.scanJobs.get(jobId);
    if (!job || job.status !== 'running') return false;
    job.status = 'stopped';
    if (job.worker) {
      void job.worker.terminate();
      job.worker = undefined;
    }
    return true;
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
      select: { id: true, _count: { select: { faces: true } } },
    });
    const total = photos.length;
    const detected = photos.filter((p) => p._count.faces > 0).length;
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
        faces: { none: {} },
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

        await tx.face.deleteMany({ where: { photoId: result.photoId } });

        if (result.faces.length === 0) return;

        await tx.face.createMany({
          data: result.faces.map((f) => ({
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

        processed++;
        facesFound += result.faces.length;
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

  async getStats(userId: string): Promise<{
    totalFaces: number;
    peopleCount: number;
    byPerson: { name: string; faceCount: number; photoCount: number }[];
  }> {
    const [totalFaces, peopleResult, allPersonData] = await Promise.all([
      this.prisma.face.count({
        where: {
          photo: { userId, deletedAt: null, private: false },
          ignored: false,
        },
      }),
      this.prisma.face.groupBy({
        by: ['personName'],
        where: {
          photo: { userId, deletedAt: null, private: false },
          personName: { not: null },
          confirmed: true,
          ignored: false,
        },
        _count: { id: true },
      }),
      this.prisma.face.findMany({
        where: {
          photo: { userId, deletedAt: null, private: false },
          personName: { not: null },
          confirmed: true,
          ignored: false,
        },
        select: { personName: true, photoId: true },
        distinct: ['personName', 'photoId'],
      }),
    ]);

    const photoCounts = new Map<string, Set<string>>();
    for (const f of allPersonData) {
      if (!f.personName) continue;
      let set = photoCounts.get(f.personName);
      if (!set) {
        set = new Set();
        photoCounts.set(f.personName, set);
      }
      set.add(f.photoId);
    }

    const byPerson = peopleResult
      .filter((p) => p.personName)
      .map((p) => ({
        name: p.personName!,
        faceCount: p._count.id,
        photoCount: photoCounts.get(p.personName!)?.size ?? 0,
      }))
      .sort((a, b) => b.photoCount - a.photoCount);

    return { totalFaces, peopleCount: byPerson.length, byPerson };
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

  async deleteFace(faceId: string, userId: string) {
    const face = await this.prisma.face.findUnique({
      where: { id: faceId },
      select: { id: true, photo: { select: { userId: true } } },
    });

    if (!face || face.photo.userId !== userId)
      throw new Error('Face not found');

    await this.prisma.face.delete({ where: { id: faceId } });
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

  async confirmAllForPerson(
    userId: string,
    personName: string,
  ): Promise<number> {
    const result = await this.prisma.face.updateMany({
      where: {
        photo: { userId, private: false },
        personName,
        confirmed: false,
        ignored: false,
      },
      data: { confirmed: true },
    });

    return result.count;
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

  async getFacesByPhoto(photoId: string, userId: string) {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { userId: true },
    });

    if (!photo || photo.userId !== userId) return [];

    return this.prisma.face.findMany({
      where: { photoId, ignored: false },
      select: {
        id: true,
        boxX: true,
        boxY: true,
        boxWidth: true,
        boxHeight: true,
        personName: true,
        confirmed: true,
      },
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
