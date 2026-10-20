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
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { FacesService } from './faces.service';
import { UpdateFaceDto } from './dto/update-face.dto';
import { MergePeopleDto } from './dto/merge-people.dto';
import { IngestFacesDto } from './dto/ingest-faces.dto';
import { sanitize } from '../common/sanitize';
import { FACE_INGEST_MAX_PHOTOS } from '../common/constants';

@Controller('faces')
export class FacesController {
  constructor(private readonly facesService: FacesService) {}

  @Get('detect-status')
  async getDetectStatus(@CurrentUser() user: { id: string }) {
    return this.facesService.getDetectStatus(user.id);
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
