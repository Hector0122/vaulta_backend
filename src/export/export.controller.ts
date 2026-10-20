import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { ExportService } from './export.service';

@Controller()
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get('exports/:id')
  getExportStatus(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.exportService.getExportStatus(id, user.id);
  }

  @Post('albums/:id/export')
  @HttpCode(HttpStatus.OK)
  async exportAlbum(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.exportService.startAlbumExport(user.id, id);
  }

  @Post('photos/export-by-date')
  @HttpCode(HttpStatus.OK)
  async exportByDate(
    @CurrentUser() user: { id: string },
    @Body() body: { dateFrom: string; dateTo: string },
  ) {
    if (!body.dateFrom || !body.dateTo)
      throw new BadRequestException('dateFrom and dateTo are required');
    return this.exportService.startDateExport(
      user.id,
      body.dateFrom,
      body.dateTo,
    );
  }
}
