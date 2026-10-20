import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma.service';
import {
  S3_CLIENT,
  getBucketName,
  stableSigning,
} from '../common/s3.provider';
import { computePerceptualHash } from '../common/image-analysis';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(S3_CLIENT) private s3: S3Client,
  ) {}

  async analyzePhoto(userId: string, photoId: string) {
    const bucket = getBucketName();

    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, userId },
    });
    if (!photo) throw new NotFoundException();

    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: photo.s3Key }),
    );
    const buffer = await response.Body?.transformToByteArray();
    if (!buffer) throw new Error('Empty response body');

    const buf = Buffer.from(buffer);
    const pHash = await computePerceptualHash(buf);

    await this.prisma.photo.update({
      where: { id: photoId },
      data: { perceptualHash: pHash },
    });

    return { perceptualHash: pHash };
  }

  async getDuplicates(userId: string) {
    const bucket = getBucketName();

    const photosWithHash = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        private: false,
        perceptualHash: { not: null },
      },
      select: {
        id: true,
        s3Key: true,
        thumbS3Key: true,
        filename: true,
        perceptualHash: true,
        blurred: true,
        blurScore: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const presigned = await Promise.all(
      photosWithHash.map(async (p) => {
        const uri = await getSignedUrl(
          this.s3,
          new GetObjectCommand({
            Bucket: bucket,
            Key: p.thumbS3Key || p.s3Key,
          }),
          stableSigning(),
        );
        return {
          id: p.id,
          url: uri,
          filename: p.filename,
          perceptualHash: p.perceptualHash!,
          blurred: p.blurred,
          blurScore: p.blurScore,
          createdAt: p.createdAt,
        };
      }),
    );

    const hashGroups = new Map<string, typeof presigned>();
    for (const p of presigned) {
      const existing = hashGroups.get(p.perceptualHash) || [];
      existing.push(p);
      hashGroups.set(p.perceptualHash, existing);
    }

    const duplicates = Array.from(hashGroups.values()).filter(
      (g) => g.length > 1,
    );
    return duplicates;
  }
}
