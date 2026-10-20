import { S3Client } from '@aws-sdk/client-s3';

export const S3_CLIENT = 'S3_CLIENT';

function r2Endpoint(): string | undefined {
  const id = process.env.R2_ACCOUNT_ID;
  return id ? `https://${id}.r2.cloudflarestorage.com` : undefined;
}

export function createS3Client(): S3Client {
  const endpoint = r2Endpoint();
  const accessKeyId =
    process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  return new S3Client({
    region: process.env.AWS_REGION || (endpoint ? 'auto' : 'us-east-1'),
    endpoint,
    forcePathStyle: !!endpoint,
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
  });
}

export function getBucketName(): string {
  const bucket = process.env.R2_BUCKET_NAME || process.env.AWS_S3_BUCKET;
  if (!bucket)
    throw new Error('R2_BUCKET_NAME or AWS_S3_BUCKET env variable is required');
  return bucket;
}

export function publicObjectUrl(bucket: string, key: string): string {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (publicUrl) {
    return `${publicUrl}/${key}`;
  }
  const endpoint = r2Endpoint();
  if (endpoint) {
    return `${endpoint}/${bucket}/${key}`;
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export const s3Provider = {
  provide: S3_CLIENT,
  useFactory: (): S3Client => createS3Client(),
};

// Signing at the start of the UTC day keeps each URL identical all day so the
// app's image cache keeps hitting; 48h expiry leaves it valid 24h+ after.
export function stableSigning() {
  const signingDate = new Date();
  signingDate.setUTCHours(0, 0, 0, 0);
  return { expiresIn: 48 * 60 * 60, signingDate };
}
