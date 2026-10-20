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
  NotFoundException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { FacesService } from './faces.service';
import { UpdateFaceDto } from './dto/update-face.dto';
import { DetectBatchDto } from './dto/detect-batch.dto';
import { MergePeopleDto } from './dto/merge-people.dto';
import { IngestFacesDto } from './dto/ingest-faces.dto';
import { sanitize } from '../common/sanitize';
import {
  FACE_DETECT_DEFAULT_LIMIT,
  FACE_DETECT_MAX_LIMIT,
  FACE_INGEST_MAX_PHOTOS,
} from '../common/constants';

@Controller('faces')
export class FacesController {
  constructor(private readonly facesService: FacesService) {}

  @Get('status')
  getStatus() {
    return {
      ready: this.facesService.ready,
      error: this.facesService.lastError || null,
      modelsDir: process.cwd() + '/models/face-api',
    };
  }

  @Post('detect/:photoId')
  @HttpCode(HttpStatus.OK)
  async detectFaces(
    @CurrentUser() user: { id: string },
    @Param('photoId') photoId: string,
  ) {
    const count = await this.facesService.detectAndSave(photoId, user.id);
    return { facesFound: count };
  }

  @Post('debug/detect/:photoId')
  @HttpCode(HttpStatus.OK)
  async detectFacesDebug(
    @CurrentUser() user: { id: string },
    @Param('photoId') photoId: string,
  ) {
    return this.facesService.detectFacesWithDebug(photoId, user.id);
  }

  @Post('detect-batch')
  @HttpCode(HttpStatus.OK)
  async detectBatch(
    @CurrentUser() user: { id: string },
    @Body() dto: DetectBatchDto,
  ) {
    return this.facesService.detectBatch(user.id, dto.photoIds);
  }

  @Post('detect-all')
  @HttpCode(HttpStatus.OK)
  async detectAll(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
  ) {
    let effectiveLimit = limit
      ? parseInt(limit, 10)
      : FACE_DETECT_DEFAULT_LIMIT;
    if (isNaN(effectiveLimit) || effectiveLimit < 1) {
      effectiveLimit = FACE_DETECT_DEFAULT_LIMIT;
    }
    if (effectiveLimit > FACE_DETECT_MAX_LIMIT) {
      effectiveLimit = FACE_DETECT_MAX_LIMIT;
    }
    return this.facesService.detectAll(user.id, effectiveLimit);
  }

  @Get('detect-status')
  async getDetectStatus(@CurrentUser() user: { id: string }) {
    return this.facesService.getDetectStatus(user.id);
  }

  @Get('detect-progress/:jobId')
  getDetectProgress(@Param('jobId') jobId: string) {
    const progress = this.facesService.getDetectProgress(jobId);
    if (!progress) throw new NotFoundException('Job not found');
    return progress;
  }

  @Post('detect-stop')
  @HttpCode(HttpStatus.OK)
  stopDetectAll(@Body('jobId') jobId: string) {
    const stopped = this.facesService.stopDetectAll(jobId);
    return { stopped };
  }

  @Get('pending')
  async getPending(
    @CurrentUser() user: { id: string },
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
    @Query('page') page?: string,
  ) {
    return this.facesService.getPendingPhotos(
      user.id,
      take ? parseInt(take, 10) : 50,
      cursor,
      page ? parseInt(page, 10) : undefined,
    );
  }

  @Get('confirmed-encodings')
  async getConfirmedEncodings(@CurrentUser() user: { id: string }) {
    return this.facesService.getConfirmedEncodings(user.id);
  }

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  async ingestFaces(
    @CurrentUser() user: { id: string },
    @Body() dto: IngestFacesDto,
  ) {
    if (dto.results.length > FACE_INGEST_MAX_PHOTOS) {
      throw new BadRequestException(
        `Max ${FACE_INGEST_MAX_PHOTOS} photos per request`,
      );
    }
    return this.facesService.ingestResults(user.id, dto.results);
  }

  @Post('cleanup-private')
  @HttpCode(HttpStatus.OK)
  async cleanupPrivateFaces(@CurrentUser() user: { id: string }) {
    return this.facesService.cleanupPrivateFaces(user.id);
  }

  @Get('unconfirmed')
  async getUnconfirmed(@CurrentUser() user: { id: string }) {
    return this.facesService.getUnconfirmed(user.id);
  }

  @Get('people')
  async getPeople(@CurrentUser() user: { id: string }) {
    return this.facesService.getPeople(user.id);
  }

  @Get('photos')
  async getPhotosByPerson(
    @CurrentUser() user: { id: string },
    @Query('person') person: string,
    @Query('pageToken') pageToken?: string,
    @Query('maxKeys') maxKeys?: string,
  ) {
    if (!person || typeof person !== 'string')
      throw new BadRequestException('person query param is required');
    const sanitized = sanitize(person, 50);
    if (!sanitized)
      throw new BadRequestException('person is empty after sanitization');
    return this.facesService.getPhotosByPerson(
      user.id,
      sanitized,
      pageToken,
      maxKeys ? parseInt(maxKeys, 10) : 50,
    );
  }

  @Get('stats')
  async getStats(@CurrentUser() user: { id: string }) {
    return this.facesService.getStats(user.id);
  }

  @Get('find-more')
  async findMoreFaces(
    @CurrentUser() user: { id: string },
    @Query('person') person: string,
  ) {
    if (!person || typeof person !== 'string')
      throw new BadRequestException('person query param is required');
    const sanitized = sanitize(person, 50);
    if (!sanitized)
      throw new BadRequestException('person is empty after sanitization');
    return this.facesService.findMoreFaces(user.id, sanitized);
  }

  @Get('photo/:photoId')
  async getFacesByPhoto(
    @CurrentUser() user: { id: string },
    @Param('photoId') photoId: string,
  ) {
    return this.facesService.getFacesByPhoto(photoId, user.id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async updateFace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() dto: UpdateFaceDto,
  ) {
    const result = await this.facesService.updateFace(id, user.id, dto);
    if (!result) throw new BadRequestException('Face not found');
    return result;
  }

  @Delete('by-photo/:photoId')
  @HttpCode(HttpStatus.OK)
  async deleteFacesByPhoto(
    @CurrentUser() user: { id: string },
    @Param('photoId') photoId: string,
    @Query('person') person?: string,
  ) {
    const sanitized = person ? sanitize(person, 50) : undefined;
    return this.facesService.deleteFacesByPhoto(photoId, user.id, sanitized);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteFace(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    await this.facesService.deleteFace(id, user.id);
    return { deleted: true };
  }

  @Post('confirm-all')
  @HttpCode(HttpStatus.OK)
  async confirmAll(
    @CurrentUser() user: { id: string },
    @Body('personName') personName: string,
  ) {
    if (!personName || typeof personName !== 'string')
      throw new BadRequestException('personName is required');
    const count = await this.facesService.confirmAllForPerson(
      user.id,
      sanitize(personName, 50),
    );
    return { confirmed: count };
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  async mergePeople(
    @CurrentUser() user: { id: string },
    @Body() dto: MergePeopleDto,
  ) {
    const count = await this.facesService.mergePeople(
      user.id,
      sanitize(dto.fromPerson, 50),
      sanitize(dto.toPerson, 50),
    );
    return { merged: count };
  }
}
