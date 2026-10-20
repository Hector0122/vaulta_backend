import {
  Injectable,
  Inject,
  NotFoundException,
  UnprocessableEntityException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { PrismaService } from '../prisma.service';
import { S3_CLIENT, getBucketName, stableSigning } from '../common/s3.provider';
import { FirebaseService } from '../firebase/firebase.service';
import { FacesService } from '../faces/faces.service';

@Injectable()
export class PhotosService implements OnModuleInit {
  private readonly logger = new Logger(PhotosService.name);
  private _batches = new Map<
    string,
    {
      userId: string;
      status: string;
      completed: number;
      failed: number;
      total: number;
      message: string;
    }
  >();
  private getPresignedUrl(bucket: string, key: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      stableSigning(),
    );
  }

  constructor(
    private prisma: PrismaService,
    @Inject(S3_CLIENT) private s3: S3Client,
    private firebase: FirebaseService,
    private facesService: FacesService,
  ) {}

  onModuleInit() {
    void this.cleanExpiredTrash();
    setInterval(() => void this.cleanExpiredTrash(), 6 * 60 * 60 * 1000);
  }

  private async cleanExpiredTrash() {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const expired = await this.prisma.photo.findMany({
        where: { deletedAt: { lte: thirtyDaysAgo } },
        select: { id: true, s3Key: true, thumbS3Key: true },
      });
      if (expired.length === 0) return;
      const bucket = getBucketName();
      const s3Keys = expired.flatMap((p) => {
        const keys = [p.s3Key];
        if (p.thumbS3Key) keys.push(p.thumbS3Key);
        return keys;
      });
      await Promise.allSettled(
        s3Keys.map((key) =>
          this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
        ),
      );
      await this.prisma.photo.deleteMany({
        where: { id: { in: expired.map((p) => p.id) } },
      });
      this.logger.log(
        `Auto-limpiadas ${expired.length} foto(s) de la papelera (30+ días)`,
      );
    } catch (err) {
      this.logger.error('Error en cleanExpiredTrash', (err as Error).message);
    }
  }

  getBatchStatus(batchId: string, userId: string) {
    const batch = this._batches.get(batchId);
    if (!batch || batch.userId !== userId) {
      return {
        status: 'not_found',
        completed: 0,
        failed: 0,
        total: 0,
        message: '',
      };
    }
    return batch;
  }

  private async findOwnedPhoto(photoId: string, userId: string) {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
    });
    if (!photo || photo.userId !== userId || photo.deletedAt)
      throw new NotFoundException();
    return photo;
  }

  private spawnUploadWorker(
    batchId: string,
    userId: string,
    files: Express.Multer.File[],
  ): Worker {
    return new Worker(path.join(__dirname, 'upload.worker.js'), {
      workerData: {
        batchId,
        userId,
        files: files.map((f) => ({
          path: f.path,
          filename: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
        })),
        bucket: getBucketName(),
        region: process.env.AWS_REGION || 'us-east-1',
        r2AccountId: process.env.R2_ACCOUNT_ID,
      },
    });
  }

  private detectFacesInBackground(userId: string, photoIds: string[]) {
    this.facesService
      .detectBatch(userId, photoIds)
      .catch((err: Error) =>
        this.logger.error(`Face detection failed: ${err.message}`),
      );
  }

  async uploadOne(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ id: string; duplicate: boolean }> {
    const result = await new Promise<{
      photoIds: string[];
      existingIds: string[];
      lastError: string;
    }>((resolve, reject) => {
      const worker = this.spawnUploadWorker(crypto.randomUUID(), userId, [
        file,
      ]);
      worker.on('message', (msg: any) => {
        if (msg.type === 'done') resolve(msg);
        else if (msg.type === 'error') reject(new Error(msg.message));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Upload worker exited with ${code}`));
      });
    });

    if (result.photoIds.length > 0) {
      this.detectFacesInBackground(userId, result.photoIds);
      return { id: result.photoIds[0], duplicate: false };
    }
    if (result.existingIds.length > 0)
      return { id: result.existingIds[0], duplicate: true };
    throw new UnprocessableEntityException(
      result.lastError || 'No se pudo procesar el archivo',
    );
  }

  // ponytail: legacy batch flow kept only for app v1.3 and older; delete it
  // (plus upload-batch endpoints and _batches) once v1.4 is installed.
  // eslint-disable-next-line @typescript-eslint/require-await
  async startBatchUpload(
    userId: string,
    files: Express.Multer.File[],
  ): Promise<string> {
    const batchId = crypto.randomUUID();

    this._batches.set(batchId, {
      userId,
      status: 'pending',
      completed: 0,
      failed: 0,
      total: files.length,
      message: 'Iniciando subida…',
    });

    let worker: Worker;
    try {
      worker = this.spawnUploadWorker(batchId, userId, files);
    } catch (err) {
      this.logger.error(`Failed to create worker: ${(err as Error).message}`);
      const b = this._batches.get(batchId);
      if (b) {
        b.status = 'error';
        b.message = `Error al iniciar worker: ${(err as Error).message}`;
      }
      return batchId;
    }

    worker.on('message', (msg: any) => {
      const b = this._batches.get(msg.batchId);
      if (!b) return;

      if (msg.type === 'progress') {
        this._batches.set(msg.batchId, {
          ...b,
          status: msg.message.startsWith('Error') ? 'error' : 'processing',
          completed: msg.completed,
          failed: msg.failed,
          message: msg.message,
        });
        if (msg.message.startsWith('Error')) this.logger.warn(msg.message);
      } else if (msg.type === 'done') {
        this._batches.set(msg.batchId, {
          ...b,
          status: 'done',
          completed: msg.completed,
          failed: msg.failed,
          message: msg.message,
        });
        this.firebase
          .sendToUser(userId, {
            title: 'Subida completada',
            body: msg.message,
          })
          .catch((err) =>
            this.logger.error('Firebase notification error', err),
          );
        if (msg.photoIds?.length > 0)
          this.detectFacesInBackground(userId, msg.photoIds);
      } else if (msg.type === 'error') {
        this._batches.set(msg.batchId, {
          ...b,
          status: 'error',
          message: msg.message,
        });
        this.logger.error(`Upload batch ${batchId} failed: ${msg.message}`);
      }
    });

    worker.on('error', (err) => {
      this.logger.error(
        `Worker error for batch ${batchId}: ${err.message}`,
        err.stack,
      );
      const b = this._batches.get(batchId);
      if (b) {
        this._batches.set(batchId, {
          ...b,
          status: 'error',
          message: err.message,
        });
      }
    });

    worker.on('exit', (code) => {
      this.logger.log(`Worker for batch ${batchId} exited with code ${code}`);
      setTimeout(() => this._batches.delete(batchId), 10 * 60 * 1000);
    });

    return batchId;
  }

  async getPhotos(
    userId: string,
    cursor?: string,
    maxKeys: number = 50,
    query?: string,
    favoritesOnly?: boolean,
    privateOnly?: boolean,
    dateFrom?: string,
    dateTo?: string,
    person?: string,
  ) {
    const bucket = getBucketName();

    let photoIds: string[] | undefined;

    if (person) {
      const faceRecords = await this.prisma.face.findMany({
        where: {
          photo: { userId, deletedAt: null, private: false },
          personName: person,
          confirmed: true,
          ignored: false,
        },
        select: { photoId: true },
        distinct: ['photoId'],
      });
      photoIds = faceRecords.map((f) => f.photoId);
      if (photoIds.length === 0) return { photos: [], nextToken: null };
    }

    const dbPhotos = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(photoIds ? { id: { in: photoIds } } : {}),
        ...(favoritesOnly ? { favorite: true } : {}),
        ...(privateOnly ? { private: true } : { private: false }),
        ...(query
          ? {
              OR: [
                { filename: { contains: query, mode: 'insensitive' } },
                { tags: { has: query.toLowerCase() } },
              ],
            }
          : {}),
        ...(dateFrom || dateTo
          ? {
              createdAt: {
                ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                ...(dateTo ? { lte: new Date(dateTo) } : {}),
              },
            }
          : {}),
      },
      take: maxKeys,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: 'desc' },
    });

    const results = await Promise.all(
      dbPhotos.map(async (photo) => {
        const thumbKey = photo.thumbS3Key;
        const largeKey = photo.largeS3Key;
        const [uri, fullUri, largeUri] = await Promise.all([
          this.getPresignedUrl(bucket, thumbKey || photo.s3Key),
          this.getPresignedUrl(bucket, photo.s3Key),
          largeKey
            ? this.getPresignedUrl(bucket, largeKey)
            : Promise.resolve(null),
        ]);
        return {
          uri,
          fullUri,
          largeUri,
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

  async getPhotoDetail(
    userId: string,
    photoId: string,
  ): Promise<{
    url: string;
    largeUri: string | null;
    albums: { id: string; name: string; vault: boolean }[];
    favorite: boolean;
    private: boolean;
  }> {
    const bucket = getBucketName();
    const photo = await this.findOwnedPhoto(photoId, userId);

    const [url, largeUri, albums] = await Promise.all([
      this.getPresignedUrl(bucket, photo.s3Key),
      photo.largeS3Key
        ? this.getPresignedUrl(bucket, photo.largeS3Key)
        : Promise.resolve(null),
      this.prisma.album.findMany({
        where: { userId, photos: { some: { id: photoId } } },
        select: { id: true, name: true, vault: true },
      }),
    ]);

    return {
      url,
      largeUri,
      albums,
      favorite: photo.favorite,
      private: photo.private,
    };
  }

  async getPhotoUrl(userId: string, photoId: string): Promise<string> {
    const bucket = getBucketName();
    const photo = await this.findOwnedPhoto(photoId, userId);

    return this.getPresignedUrl(bucket, photo.s3Key);
  }

  async getPhotoStream(userId: string, photoId: string, range?: string) {
    const bucket = getBucketName();
    const photo = await this.findOwnedPhoto(photoId, userId);

    const commandInput: any = { Bucket: bucket, Key: photo.s3Key };
    if (range) commandInput.Range = range;

    const command = new GetObjectCommand(commandInput);
    const response = await this.s3.send(command);
    return {
      stream: response.Body as NodeJS.ReadableStream,
      contentType: photo.mimeType,
      contentLength: response.ContentLength ?? photo.size,
      contentRange: response.ContentRange as string | undefined,
      isPartial: !!range,
    };
  }

  async toggleFavorite(userId: string, photoId: string): Promise<boolean> {
    const photo = await this.findOwnedPhoto(photoId, userId);

    const updated = await this.prisma.photo.update({
      where: { id: photoId },
      data: { favorite: !photo.favorite },
    });
    return updated.favorite;
  }

  async addTag(
    userId: string,
    photoId: string,
    tag: string,
  ): Promise<{ tags: string[]; linkedPerson: string | null }> {
    const photo = await this.findOwnedPhoto(photoId, userId);

    const normalized = tag.trim().toLowerCase();
    if (!normalized) return { tags: photo.tags, linkedPerson: null };
    if (photo.tags.includes(normalized))
      return { tags: photo.tags, linkedPerson: null };

    const updated = await this.prisma.photo.update({
      where: { id: photoId },
      data: { tags: { push: normalized } },
    });

    const personExists = await this.prisma.face.findFirst({
      where: {
        photo: { userId },
        personName: normalized,
        confirmed: true,
        ignored: false,
      },
    });

    return {
      tags: updated.tags,
      linkedPerson: personExists ? normalized : null,
    };
  }

  async removeTag(
    userId: string,
    photoId: string,
    tag: string,
  ): Promise<string[]> {
    const photo = await this.findOwnedPhoto(photoId, userId);

    const updated = await this.prisma.photo.update({
      where: { id: photoId },
      data: {
        tags: { set: photo.tags.filter((t) => t !== tag.toLowerCase()) },
      },
    });
    return updated.tags;
  }
  async getThisDayPhotos(userId: string, person?: string, date?: string) {
    const bucket = getBucketName();

    const now = new Date();
    const [thisYear, month, day] =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date.split('-').map(Number)
        : [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];

    let photos: Array<{
      id: string;
      createdAt: Date;
      s3Key: string;
      thumbS3Key: string | null;
      largeS3Key: string | null;
      filename: string;
    }>;

    if (person) {
      photos = await this.prisma.$queryRaw`
        SELECT DISTINCT p.id, p."createdAt", p."s3Key", p."thumbS3Key", p."largeS3Key", p.filename
        FROM "Photo" p
        INNER JOIN "Face" f ON f."photoId" = p.id
        WHERE p."userId" = ${userId}
          AND p."deletedAt" IS NULL
          AND p."private" = false
          AND f."personName" = ${person}
          AND f."confirmed" = true
          AND f."ignored" = false
          AND EXTRACT(MONTH FROM p."createdAt") = ${month}::int
          AND EXTRACT(DAY FROM p."createdAt") = ${day}::int
          AND EXTRACT(YEAR FROM p."createdAt") != ${thisYear}::int
        ORDER BY p."createdAt" DESC
      `;
    } else {
      photos = await this.prisma.$queryRaw`
        SELECT id, "createdAt", "s3Key", "thumbS3Key", "largeS3Key", filename
        FROM "Photo"
        WHERE "userId" = ${userId}
          AND "deletedAt" IS NULL
          AND "private" = false
          AND EXTRACT(MONTH FROM "createdAt") = ${month}::int
          AND EXTRACT(DAY FROM "createdAt") = ${day}::int
          AND EXTRACT(YEAR FROM "createdAt") != ${thisYear}::int
        ORDER BY "createdAt" DESC
      `;
    }

    const grouped = new Map<number, typeof photos>();
    for (const p of photos) {
      const year = new Date(p.createdAt).getFullYear();
      const existing = grouped.get(year) || [];
      existing.push(p);
      grouped.set(year, existing);
    }

    const result = await Promise.all(
      Array.from(grouped.entries())
        .sort(([a], [b]) => b - a)
        .map(async ([year, yearPhotos]) => {
          const photo = yearPhotos[0];
          const thumbKey = photo.thumbS3Key || photo.s3Key;
          const largeKey = photo.largeS3Key;
          const [uri, fullUri, largeUri] = await Promise.all([
            this.getPresignedUrl(bucket, thumbKey),
            this.getPresignedUrl(bucket, photo.s3Key),
            largeKey
              ? this.getPresignedUrl(bucket, largeKey)
              : Promise.resolve(null),
          ]);
          return {
            year,
            uri,
            fullUri,
            largeUri,
            id: photo.id,
            filename: photo.filename,
            count: yearPhotos.length,
            yearsAgo: thisYear - year,
          };
        }),
    );

    return result;
  }

  async getStats(userId: string) {
    const [
      photoCount,
      albumCount,
      favoriteCount,
      storageResult,
      faceCount,
      peopleResult,
    ] = await Promise.all([
      this.prisma.photo.count({
        where: { userId, deletedAt: null, private: false },
      }),
      this.prisma.album.count({ where: { userId } }),
      this.prisma.photo.count({
        where: { userId, deletedAt: null, private: false, favorite: true },
      }),
      this.prisma.photo.aggregate({
        where: { userId, deletedAt: null },
        _sum: { size: true },
      }),
      this.prisma.face.count({
        where: { photo: { userId, deletedAt: null }, ignored: false },
      }),
      this.prisma.face.groupBy({
        by: ['personName'],
        where: {
          photo: { userId, deletedAt: null },
          personName: { not: null },
          confirmed: true,
          ignored: false,
        },
        _count: { id: true },
      }),
    ]);
    const totalSize = storageResult._sum.size ?? 0;
    const peopleCount = peopleResult.filter((p) => p.personName).length;
    return {
      photoCount,
      albumCount,
      favoriteCount,
      totalSize,
      faceCount,
      peopleCount,
    };
  }

  async togglePrivate(userId: string, photoId: string): Promise<boolean> {
    const photo = await this.findOwnedPhoto(photoId, userId);

    const newPrivate = !photo.private;

    if (newPrivate) {
      let vault = await this.prisma.album.findFirst({
        where: { userId, vault: true },
      });
      if (!vault) {
        vault = await this.prisma.album.create({
          data: { name: 'Caja Fuerte', userId, vault: true },
        });
      }
      await this.prisma.album.update({
        where: { id: vault.id },
        data: { photos: { connect: { id: photoId } } },
      });
      const nonVaultAlbums = await this.prisma.album.findMany({
        where: { userId, vault: false, photos: { some: { id: photoId } } },
        select: { id: true },
      });
      for (const a of nonVaultAlbums) {
        await this.prisma.album.update({
          where: { id: a.id },
          data: { photos: { disconnect: { id: photoId } } },
        });
      }
    } else {
      const vault = await this.prisma.album.findFirst({
        where: { userId, vault: true },
      });
      if (vault) {
        await this.prisma.album.update({
          where: { id: vault.id },
          data: { photos: { disconnect: { id: photoId } } },
        });
      }
    }

    const updated = await this.prisma.photo.update({
      where: { id: photoId },
      data: { private: newPrivate },
    });
    return updated.private;
  }

  async bulkSetPrivate(
    userId: string,
    photoIds: string[],
  ): Promise<{ marked: number; skipped: number }> {
    const photos = await this.prisma.photo.findMany({
      where: { id: { in: photoIds }, userId, deletedAt: null },
      select: { id: true, private: true },
    });

    const toMark = photos.filter((p) => !p.private);
    if (toMark.length === 0) return { marked: 0, skipped: photos.length };

    let vault = await this.prisma.album.findFirst({
      where: { userId, vault: true },
    });
    if (!vault) {
      vault = await this.prisma.album.create({
        data: { name: 'Caja Fuerte', userId, vault: true },
      });
    }

    const nonVaultAlbums = await this.prisma.album.findMany({
      where: {
        userId,
        vault: false,
        photos: { some: { id: { in: toMark.map((p) => p.id) } } },
      },
      select: {
        id: true,
        photos: {
          select: { id: true },
          where: { id: { in: toMark.map((p) => p.id) } },
        },
      },
    });

    await this.prisma.album.update({
      where: { id: vault.id },
      data: { photos: { connect: toMark.map((p) => ({ id: p.id })) } },
    });

    for (const a of nonVaultAlbums) {
      await this.prisma.album.update({
        where: { id: a.id },
        data: { photos: { disconnect: a.photos.map((p) => ({ id: p.id })) } },
      });
    }

    await this.prisma.photo.updateMany({
      where: { id: { in: toMark.map((p) => p.id) } },
      data: { private: true },
    });

    return { marked: toMark.length, skipped: photos.length - toMark.length };
  }

  async getPhotoAlbums(
    userId: string,
    photoId: string,
  ): Promise<{ id: string; name: string; vault: boolean }[]> {
    await this.findOwnedPhoto(photoId, userId);

    return this.prisma.album.findMany({
      where: { userId, photos: { some: { id: photoId } } },
      select: { id: true, name: true, vault: true },
    });
  }

  async softDeletePhoto(userId: string, photoId: string): Promise<void> {
    await this.findOwnedPhoto(photoId, userId);

    await this.prisma.photo.update({
      where: { id: photoId },
      data: { deletedAt: new Date() },
    });
  }

  async bulkSoftDelete(
    userId: string,
    ids: string[],
  ): Promise<{ deleted: number }> {
    const result = await this.prisma.photo.updateMany({
      where: { id: { in: ids }, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { deleted: result.count };
  }

  async restorePhoto(userId: string, photoId: string): Promise<void> {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
    });
    if (!photo || photo.userId !== userId || !photo.deletedAt)
      throw new NotFoundException();

    await this.prisma.photo.update({
      where: { id: photoId },
      data: { deletedAt: null },
    });
  }

  private resolveS3Key(
    storedKey: string | null,
    fallbackKey: string,
    prefix: 'uploads' | 'thumbnails' | 'large',
  ): string {
    if (storedKey) {
      if (storedKey.includes('/')) return storedKey;
      return `${prefix}/${storedKey}`;
    }
    if (fallbackKey.includes('/')) {
      return fallbackKey.replace(/^uploads\//, `${prefix}/`);
    }
    return `${prefix}/${fallbackKey}`;
  }

  async getTrash(userId: string, cursor?: string, maxKeys: number = 50) {
    const bucket = getBucketName();

    const photos = await this.prisma.photo.findMany({
      where: { userId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      take: maxKeys,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const results = await Promise.all(
      photos.map(async (photo) => {
        const thumbKey = this.resolveS3Key(
          photo.thumbS3Key,
          photo.s3Key,
          'thumbnails',
        );
        const fullKey = this.resolveS3Key(photo.s3Key, photo.s3Key, 'uploads');
        const largeKey = photo.largeS3Key
          ? this.resolveS3Key(photo.largeS3Key, photo.s3Key, 'large')
          : null;
        const [uri, fullUri, largeUri] = await Promise.all([
          this.getPresignedUrl(bucket, thumbKey),
          this.getPresignedUrl(bucket, fullKey),
          largeKey
            ? this.getPresignedUrl(bucket, largeKey)
            : Promise.resolve(null),
        ]);
        return {
          id: photo.id,
          uri,
          fullUri,
          largeUri,
          filename: photo.filename,
          deletedAt: photo.deletedAt,
          size: photo.size,
        };
      }),
    );

    const nextToken =
      photos.length === maxKeys ? photos[photos.length - 1].id : null;
    return { photos: results, nextToken };
  }

  async permanentlyDeletePhoto(userId: string, photoId: string): Promise<void> {
    const bucket = getBucketName();

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
    });
    if (!photo || photo.userId !== userId || !photo.deletedAt)
      throw new NotFoundException();

    const s3Keys = [this.resolveS3Key(photo.s3Key, photo.s3Key, 'uploads')];
    if (photo.thumbS3Key || photo.s3Key) {
      s3Keys.push(
        this.resolveS3Key(photo.thumbS3Key, photo.s3Key, 'thumbnails'),
      );
    }

    await Promise.allSettled(
      s3Keys.map((key) =>
        this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      ),
    );

    await this.prisma.photo.delete({ where: { id: photoId } });
  }

  async emptyTrash(userId: string): Promise<{ deleted: number }> {
    const bucket = getBucketName();

    const trash = await this.prisma.photo.findMany({
      where: { userId, deletedAt: { not: null } },
      select: { id: true, s3Key: true, thumbS3Key: true },
    });

    if (trash.length === 0) return { deleted: 0 };

    const s3Keys = trash.flatMap((p) => {
      const keys = [
        this.resolveS3Key(p.s3Key, p.s3Key, 'uploads'),
        this.resolveS3Key(p.thumbS3Key, p.s3Key, 'thumbnails'),
      ];
      return keys;
    });

    await Promise.allSettled(
      s3Keys.map((key) =>
        this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      ),
    );

    await this.prisma.photo.deleteMany({
      where: { id: { in: trash.map((p) => p.id) } },
    });

    return { deleted: trash.length };
  }
}
