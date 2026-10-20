import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3_CLIENT, getBucketName, stableSigning } from '../common/s3.provider';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AlbumsService {
  constructor(
    private prisma: PrismaService,
    @Inject(S3_CLIENT) private s3: S3Client,
  ) {}

  async list(userId: string) {
    const bucket = process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET;
    const albums = await this.prisma.album.findMany({
      where: { userId, vault: false },
      include: { _count: { select: { photos: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!bucket) return albums;

    const coverIds = albums
      .filter((a) => a.coverPhotoId)
      .map((a) => a.coverPhotoId!);
    const covers = new Map<string, string | null>();

    if (coverIds.length > 0) {
      const photos = await this.prisma.photo.findMany({
        where: { id: { in: coverIds } },
        select: { id: true, thumbS3Key: true, s3Key: true },
      });
      await Promise.all(
        photos.map(async (p) => {
          covers.set(
            p.id,
            await getSignedUrl(
              this.s3,
              new GetObjectCommand({
                Bucket: bucket,
                Key: p.thumbS3Key || p.s3Key,
              }),
              stableSigning(),
            ),
          );
        }),
      );
    }

    return albums.map((a) => ({
      ...a,
      coverUri: covers.get(a.coverPhotoId ?? '') ?? null,
    }));
  }

  async create(userId: string, name: string, vault?: boolean) {
    return this.prisma.album.create({
      data: { name, userId, vault: !!vault },
    });
  }

  async listVaultAlbums(userId: string) {
    const bucket = process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET;
    const albums = await this.prisma.album.findMany({
      where: { userId, vault: true, name: { not: 'Caja Fuerte' } },
      include: { _count: { select: { photos: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (!bucket) return albums;

    const coverIds = albums
      .filter((a) => a.coverPhotoId)
      .map((a) => a.coverPhotoId!);
    const covers = new Map<string, string | null>();

    if (coverIds.length > 0) {
      const photos = await this.prisma.photo.findMany({
        where: { id: { in: coverIds } },
        select: { id: true, thumbS3Key: true, s3Key: true },
      });
      await Promise.all(
        photos.map(async (p) => {
          covers.set(
            p.id,
            await getSignedUrl(
              this.s3,
              new GetObjectCommand({
                Bucket: bucket,
                Key: p.thumbS3Key || p.s3Key,
              }),
              stableSigning(),
            ),
          );
        }),
      );
    }

    return albums.map((a) => ({
      ...a,
      coverUri: covers.get(a.coverPhotoId ?? '') ?? null,
    }));
  }

  async getVault(userId: string) {
    const existing = await this.prisma.album.findFirst({
      where: { userId, vault: true },
      include: {
        photos: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
      },
    });
    let vault =
      existing ||
      (await this.prisma.album.create({
        data: { name: 'Caja Fuerte', userId, vault: true },
        include: {
          photos: {
            where: { deletedAt: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          },
        },
      }));

    const orphanPrivates = await this.prisma.photo.findMany({
      where: {
        userId,
        deletedAt: null,
        private: true,
        albums: { none: { id: vault.id } },
      },
      select: { id: true },
    });
    if (orphanPrivates.length > 0) {
      await this.prisma.album.update({
        where: { id: vault.id },
        data: {
          photos: { connect: orphanPrivates.map((p) => ({ id: p.id })) },
        },
      });
      const vaultWithNew = await this.prisma.album.findFirst({
        where: { id: vault.id },
        include: {
          photos: {
            where: { deletedAt: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          },
        },
      });
      if (vaultWithNew) vault = vaultWithNew;
    }

    const bucket = process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET;
    if (!bucket) return vault as any;

    const results = await Promise.all(
      vault.photos.map(async (photo: any) => {
        const thumbKey = photo.thumbS3Key;
        const uri = await getSignedUrl(
          this.s3,
          new GetObjectCommand({
            Bucket: bucket,
            Key: thumbKey || photo.s3Key,
          }),
          stableSigning(),
        );
        return {
          uri,
          id: photo.id,
          createdAt: photo.createdAt,
          private: photo.private,
        };
      }),
    );
    return {
      id: vault.id,
      name: vault.name,
      photos: results,
      _count: { photos: results.length },
    };
  }

  async delete(userId: string, albumId: string) {
    const album = await this.prisma.album.findFirst({
      where: { id: albumId, userId },
    });
    if (!album) throw new NotFoundException('Album not found');
    if (album.vault)
      throw new NotFoundException('No se puede eliminar la caja fuerte');
    await this.prisma.album.delete({ where: { id: albumId } });
  }

  async addPhotos(userId: string, albumId: string, photoIds: string[]) {
    const album = await this.prisma.album.findFirst({
      where: { id: albumId, userId },
      include: { photos: { select: { id: true } } },
    });
    if (!album) throw new NotFoundException('Album not found');

    const owned = await this.prisma.photo.findMany({
      where: { id: { in: photoIds }, userId, deletedAt: null },
      select: { id: true, private: true },
    });
    if (owned.length !== photoIds.length)
      throw new NotFoundException('One or more photos not found');

    if (!album.vault) {
      const privates = owned.filter((p) => p.private);
      if (privates.length > 0)
        throw new BadRequestException(
          'No se pueden agregar fotos privadas a este álbum',
        );
    }

    const existing = new Set(album.photos.map((p) => p.id));
    const newPhotoIds = photoIds.filter((id) => !existing.has(id));

    if (newPhotoIds.length === 0)
      return { added: 0, alreadyInAlbum: photoIds.length };

    if (album.vault) {
      await this.prisma.photo.updateMany({
        where: { id: { in: newPhotoIds } },
        data: { private: true },
      });
    }

    await this.prisma.album.update({
      where: { id: albumId },
      data: {
        photos: {
          connect: newPhotoIds.map((id) => ({ id })),
        },
      },
    });
    return {
      added: newPhotoIds.length,
      alreadyInAlbum: photoIds.length - newPhotoIds.length,
    };
  }

  async update(
    userId: string,
    albumId: string,
    body: { name?: string; coverPhotoId?: string | null },
  ) {
    const album = await this.prisma.album.findFirst({
      where: { id: albumId, userId },
    });
    if (!album) throw new NotFoundException('Album not found');

    const data: { name?: string; coverPhotoId?: string | null } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.coverPhotoId !== undefined) {
      if (body.coverPhotoId !== null) {
        const photo = await this.prisma.photo.findFirst({
          where: { id: body.coverPhotoId, userId },
        });
        if (!photo) throw new NotFoundException('Photo not found');
      }
      data.coverPhotoId = body.coverPhotoId;
    }

    return this.prisma.album.update({
      where: { id: albumId },
      data,
    });
  }

  async getPhotos(
    userId: string,
    albumId: string,
    cursor?: string,
    maxKeys: number = 50,
  ) {
    const bucket = getBucketName();

    const albumMeta = await this.prisma.album.findFirst({
      where: { id: albumId, userId },
      select: { id: true, vault: true },
    });
    if (!albumMeta) throw new NotFoundException('Album not found');

    const photos = await this.prisma.photo.findMany({
      where: {
        albums: { some: { id: albumId } },
        deletedAt: null,
        ...(albumMeta.vault ? {} : { private: false }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: maxKeys,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const results = await Promise.all(
      photos.map(async (photo) => {
        const thumbKey = photo.thumbS3Key;
        const largeKey = photo.largeS3Key;
        const [uri, fullUri, largeUri] = await Promise.all([
          getSignedUrl(
            this.s3,
            new GetObjectCommand({
              Bucket: bucket,
              Key: thumbKey || photo.s3Key,
            }),
            stableSigning(),
          ),
          getSignedUrl(
            this.s3,
            new GetObjectCommand({
              Bucket: bucket,
              Key: photo.s3Key,
            }),
            stableSigning(),
          ),
          largeKey
            ? getSignedUrl(
                this.s3,
                new GetObjectCommand({
                  Bucket: bucket,
                  Key: largeKey,
                }),
                stableSigning(),
              )
            : Promise.resolve(null),
        ]);
        return {
          uri,
          fullUri,
          largeUri,
          id: photo.id,
          createdAt: photo.createdAt,
          private: photo.private,
        };
      }),
    );

    const nextToken =
      photos.length === maxKeys ? photos[photos.length - 1].id : null;
    return { photos: results, nextToken };
  }

  async removePhotos(userId: string, albumId: string, photoIds: string[]) {
    const album = await this.prisma.album.findFirst({
      where: { id: albumId, userId },
    });
    if (!album) throw new NotFoundException('Album not found');

    const owned = await this.prisma.photo.count({
      where: { id: { in: photoIds }, userId, deletedAt: null },
    });
    if (owned !== photoIds.length)
      throw new NotFoundException('One or more photos not found');

    if (album.vault) {
      await this.prisma.photo.updateMany({
        where: { id: { in: photoIds } },
        data: { private: false },
      });
    }

    await this.prisma.album.update({
      where: { id: albumId },
      data: {
        photos: {
          disconnect: photoIds.map((id) => ({ id })),
        },
      },
    });
    return { removed: photoIds.length };
  }
}
