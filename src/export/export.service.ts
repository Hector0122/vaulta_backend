import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Worker } from 'worker_threads';
import * as crypto from 'crypto';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import { getBucketName } from '../common/s3.provider';
import { FirebaseService } from '../firebase/firebase.service';
import { ExportProgress } from './export.types';

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private _exports = new Map<string, ExportProgress>();

  constructor(
    private prisma: PrismaService,
    private firebase: FirebaseService,
  ) {}

  getExportStatus(
    exportId: string,
    userId: string,
  ): ExportProgress | { status: 'not_found' } {
    const exp = this._exports.get(exportId);
    if (!exp || exp.userId !== userId) return { status: 'not_found' };
    return exp;
  }

  async startAlbumExport(
    userId: string,
    albumId: string,
  ): Promise<{ exportId: string }> {
    const album = await this.prisma.album.findFirst({
      where: { id: albumId, userId },
      include: { photos: { select: { s3Key: true, filename: true } } },
    });
    if (!album) throw new NotFoundException('Album not found');
    if (album.photos.length === 0)
      throw new BadRequestException('El álbum no tiene fotos');
    return this._startExport(userId, album.photos, `álbum "${album.name}"`);
  }

  async startDateExport(
    userId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<{ exportId: string }> {
    const photos = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        private: false,
        createdAt: {
          gte: new Date(dateFrom),
          lte: new Date(dateTo + 'T23:59:59.999Z'),
        },
      },
      select: { s3Key: true, filename: true },
    });
    if (photos.length === 0)
      throw new BadRequestException('No hay fotos en ese rango de fechas');
    return this._startExport(userId, photos, `${dateFrom} a ${dateTo}`);
  }

  private async _startExport(
    userId: string,
    photos: { s3Key: string; filename: string }[],
    label: string,
  ): Promise<{ exportId: string }> {
    const bucket = getBucketName();
    const region = process.env.AWS_REGION || 'us-east-1';

    const exportId = crypto.randomUUID();
    const progress: ExportProgress = {
      status: 'pending',
      total: photos.length,
      completed: 0,
      message: 'Iniciando exportación…',
      label,
      userId,
    };
    this._exports.set(exportId, progress);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    const workerPath = path.join(__dirname, 'export.worker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        exportId,
        userId,
        photos,
        label,
        bucket,
        region,
        r2AccountId: process.env.R2_ACCOUNT_ID,
        userEmail: user?.email,
      },
    });

    worker.on('message', (msg: any) => {
      const p = this._exports.get(msg.exportId);
      if (!p) return;

      if (msg.type === 'progress') {
        p.status = 'processing';
        p.completed = msg.completed;
        p.message = msg.message;
      } else if (msg.type === 'done') {
        p.status = 'done';
        p.message = msg.message;
        this.firebase
          .sendToUser(userId, {
            title: 'Exportación completada',
            body: msg.message,
          })
          .catch((err) =>
            this.logger.error('Firebase notification error', err),
          );
      } else if (msg.type === 'smtp_error') {
        this.logger.error(`Export ${exportId} SMTP error: ${msg.message}`);
        p.message = `Correo no enviado: ${msg.message}`;
      } else if (msg.type === 'error') {
        p.status = 'error';
        p.message = msg.message;
        this.logger.error(`Export ${exportId} failed: ${msg.message}`);
      }
    });

    worker.on('error', (err) => {
      this.logger.error(`Worker error for export ${exportId}`, err);
      const p = this._exports.get(exportId);
      if (p) {
        p.status = 'error';
        p.message = err.message;
      }
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        const p = this._exports.get(exportId);
        if (p && p.status !== 'done' && p.status !== 'error') {
          p.status = 'error';
          p.message = `Worker finalizó con código ${code}`;
        }
      }
    });

    return { exportId };
  }
}
