import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnprocessableEntityException,
  UnauthorizedException,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Res,
  Req,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SkipAuth } from '../auth/skip-auth.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import * as jwt from 'jsonwebtoken';
import { PhotosService } from './photos.service';
import { AnalysisService } from '../analysis/analysis.service';
import {
  PRESIGN_EXPIRY,
  ALLOWED_MIMES,
  MAX_FILE_SIZE,
  BATCH_MAX_FILES,
} from '../common/constants';
import { sanitize } from '../common/sanitize';

const uploadTmpDir = path.join(os.tmpdir(), 'vaulta-uploads');
if (!fs.existsSync(uploadTmpDir))
  fs.mkdirSync(uploadTmpDir, { recursive: true });

function uploadOptions() {
  return {
    storage: diskStorage({
      destination: uploadTmpDir,
      filename: (
        _req: any,
        file: Express.Multer.File,
        cb: (err: Error | null, name: string) => void,
      ) => {
        const uniqueName = `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (
      _req: any,
      file: Express.Multer.File,
      cb: (err: Error | null, accept: boolean) => void,
    ) => {
      if (ALLOWED_MIMES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(
          new UnprocessableEntityException(
            `Formato no soportado: ${file.mimetype}`,
          ),
          false,
        );
      }
    },
  };
}

@Controller()
export class PhotosController {
  constructor(
    private readonly photosService: PhotosService,
    private readonly analysisService: AnalysisService,
  ) {}

  @Get('photos')
  async getPhotos(
    @CurrentUser() user: { id: string },
    @Query('pageToken') pageToken?: string,
    @Query('maxKeys') maxKeys?: string,
    @Query('q') query?: string,
    @Query('favorites') favorites?: string,
    @Query('private') privateOnly?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('person') person?: string,
  ) {
    return this.photosService.getPhotos(
      user.id,
      pageToken,
      maxKeys ? parseInt(maxKeys, 10) : 50,
      query ? sanitize(query, 100) : undefined,
      favorites === 'true',
      privateOnly === 'true',
      dateFrom,
      dateTo,
      person ? sanitize(person, 50) : undefined,
    );
  }

  @Post('photos/upload')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', uploadOptions()))
  async uploadFile(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const batchId = await this.photosService.startBatchUpload(user.id, [file]);
    return { batchId };
  }

  @Post('photos/upload-batch')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor('files', BATCH_MAX_FILES, uploadOptions()))
  async uploadBatch(
    @CurrentUser() user: { id: string },
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!files || files.length === 0)
      throw new BadRequestException('No files provided');

    const batchId = await this.photosService.startBatchUpload(user.id, files);
    return { batchId };
  }

  @Get('photos/upload-batch/:batchId/status')
  getUploadBatchStatus(
    @CurrentUser() user: { id: string },
    @Param('batchId') batchId: string,
  ) {
    return this.photosService.getBatchStatus(batchId, user.id);
  }

  @Get('photos/this-day')
  async getThisDayPhotos(
    @CurrentUser() user: { id: string },
    @Query('person') person?: string,
  ) {
    return this.photosService.getThisDayPhotos(
      user.id,
      person ? sanitize(person, 50) : undefined,
    );
  }

  @Get('photos/stats')
  async getPhotoStats(@CurrentUser() user: { id: string }) {
    return this.photosService.getStats(user.id);
  }

  @Get('photos/trash')
  async getTrash(
    @CurrentUser() user: { id: string },
    @Query('pageToken') pageToken?: string,
    @Query('maxKeys') maxKeys?: string,
  ) {
    return this.photosService.getTrash(
      user.id,
      pageToken,
      maxKeys ? parseInt(maxKeys, 10) : 50,
    );
  }

  @Get('photos/duplicates')
  async getDuplicates(@CurrentUser() user: { id: string }) {
    return this.analysisService.getDuplicates(user.id);
  }

  // El frontend siempre manda el JWT por Authorization header (VideoPlayer +
  // PhotoPreview); el query param ?token= existía como fallback pero nada lo
  // usaba y dejaba el JWT completo en logs de servidor/proxy — eliminado.
  @SkipAuth()
  @Get('photos/:id/stream')
  async streamPhoto(
    @Param('id') id: string,
    @Res() res: any,
    @Req() req: any,
  ) {
    let userId: string;
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new UnauthorizedException('JWT_SECRET not configured');

    const authHeader = req.headers?.authorization;
    if (!authHeader) throw new UnauthorizedException();
    try {
      const payload = jwt.verify(
        authHeader.replace('Bearer ', ''),
        secret,
      ) as any;
      userId = payload.sub || payload.id;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    const rangeHeader = req.headers?.range as string | undefined;
    const { stream, contentType, contentLength, contentRange, isPartial } =
      await this.photosService.getPhotoStream(userId, id, rangeHeader);

    if (isPartial && contentRange) {
      res.status(206);
      res.setHeader('Content-Range', contentRange);
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
  }

  @Get('photos/:id')
  async getPhotoById(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return { url: await this.photosService.getPhotoUrl(user.id, id) };
  }

  @Get('photos/:id/detail')
  async getPhotoDetail(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.photosService.getPhotoDetail(user.id, id);
  }

  @Get('photos/:id/share')
  async getShareLink(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Query('expiresIn') expiresIn?: string,
  ) {
    const url = await this.photosService.getShareLink(
      user.id,
      id,
      expiresIn ? parseInt(expiresIn, 10) : PRESIGN_EXPIRY,
    );
    return { url };
  }

  @Patch('photos/:id/favorite')
  @HttpCode(HttpStatus.OK)
  async toggleFavorite(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const favorite = await this.photosService.toggleFavorite(user.id, id);
    return { favorite };
  }

  @Patch('photos/:id/private')
  @HttpCode(HttpStatus.OK)
  async togglePrivate(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    const isPrivate = await this.photosService.togglePrivate(user.id, id);
    return { private: isPrivate };
  }

  @Patch('photos/bulk-private')
  @HttpCode(HttpStatus.OK)
  async bulkSetPrivate(
    @CurrentUser() user: { id: string },
    @Body('ids') ids: string[],
  ) {
    if (!Array.isArray(ids) || ids.length === 0)
      throw new BadRequestException('ids must be a non-empty array');
    return this.photosService.bulkSetPrivate(user.id, ids);
  }

  @Post('photos/:id/tags')
  @HttpCode(HttpStatus.OK)
  async addTag(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body('tag') tag: string,
  ) {
    if (!tag || typeof tag !== 'string')
      throw new BadRequestException('tag is required');
    const sanitized = sanitize(tag, 50);
    if (!sanitized)
      throw new BadRequestException('tag is empty after sanitization');
    const result = await this.photosService.addTag(user.id, id, sanitized);
    return { tags: result.tags, linkedPerson: result.linkedPerson };
  }

  @Delete('photos/:id/tags')
  @HttpCode(HttpStatus.OK)
  async removeTag(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body('tag') tag: string,
  ) {
    if (!tag || typeof tag !== 'string')
      throw new BadRequestException('tag is required');
    const sanitized = sanitize(tag, 50);
    if (!sanitized)
      throw new BadRequestException('tag is empty after sanitization');
    const tags = await this.photosService.removeTag(user.id, id, sanitized);
    return { tags };
  }

  @Get('photos/:id/albums')
  async getPhotoAlbums(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.photosService.getPhotoAlbums(user.id, id);
  }

  @Delete('photos/bulk')
  @HttpCode(HttpStatus.OK)
  async bulkDeletePhotos(
    @CurrentUser() user: { id: string },
    @Body('ids') ids: string[],
  ) {
    if (!Array.isArray(ids) || ids.length === 0)
      throw new BadRequestException('ids must be a non-empty array');
    return this.photosService.bulkSoftDelete(user.id, ids);
  }

  @Delete('photos/trash/:id')
  @HttpCode(HttpStatus.OK)
  async permanentlyDeletePhoto(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.photosService.permanentlyDeletePhoto(user.id, id);
    return { deleted: true };
  }

  @Delete('photos/trash')
  @HttpCode(HttpStatus.OK)
  async emptyTrash(@CurrentUser() user: { id: string }) {
    return this.photosService.emptyTrash(user.id);
  }

  @Delete('photos/all')
  @HttpCode(HttpStatus.OK)
  async nukeAllPhotos(
    @CurrentUser() user: { id: string },
    @Body('confirm') confirm: string,
  ) {
    if (confirm !== 'DELETE_ALL')
      throw new BadRequestException(
        'Envía { "confirm": "DELETE_ALL" } para confirmar',
      );
    return this.photosService.nukeAllPhotos(user.id);
  }

  @Delete('photos/:id')
  @HttpCode(HttpStatus.OK)
  async deletePhoto(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.photosService.softDeletePhoto(user.id, id);
    return { deleted: true };
  }

  @Post('photos/:id/restore')
  @HttpCode(HttpStatus.OK)
  async restorePhoto(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.photosService.restorePhoto(user.id, id);
    return { restored: true };
  }
}
