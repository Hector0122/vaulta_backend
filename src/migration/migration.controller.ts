import { Controller, Post, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { MigrationService } from './migration.service';

@Controller()
export class MigrationController {
  constructor(private readonly migrationService: MigrationService) {}

  @Post('photos/migrate-thumbnails')
  @HttpCode(HttpStatus.OK)
  async migrateThumbnails() {
    return this.migrationService.generateMissingThumbnails();
  }

  @Post('photos/migrate-folders')
  @HttpCode(HttpStatus.OK)
  async migrateFolders() {
    return this.migrationService.migrateToFolders();
  }

  @Post('photos/sync-s3')
  @HttpCode(HttpStatus.OK)
  async syncS3(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
  ) {
    return this.migrationService.syncS3ToDb(
      user.id,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Post('photos/fix-video-thumbnails')
  @HttpCode(HttpStatus.OK)
  async fixVideoThumbnails() {
    return this.migrationService.fixVideoThumbnails();
  }

  @Post('photos/migrate-vault')
  @HttpCode(HttpStatus.OK)
  async migrateVault(@CurrentUser() user: { id: string }) {
    return this.migrationService.migrateVault(user.id);
  }
}
