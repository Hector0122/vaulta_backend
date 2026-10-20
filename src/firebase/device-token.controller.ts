import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma.service';

@Controller()
export class DeviceTokenController {
  constructor(private prisma: PrismaService) {}

  @Post('device-token')
  @HttpCode(HttpStatus.OK)
  async registerToken(
    @CurrentUser() user: { id: string },
    @Body() body: { token: string },
  ) {
    if (!body.token) return { ok: false, error: 'token is required' };

    await this.prisma.deviceToken.upsert({
      where: { userId_token: { userId: user.id, token: body.token } },
      update: {},
      create: { userId: user.id, token: body.token },
    });
    return { ok: true };
  }
}
