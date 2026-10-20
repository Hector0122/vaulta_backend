-- AlterTable
ALTER TABLE "Photo" ADD COLUMN "facesScannedAt" TIMESTAMP(3);

-- Photos that already have faces were scanned; photos without faces get one more scan.
UPDATE "Photo" SET "facesScannedAt" = NOW() WHERE "id" IN (SELECT DISTINCT "photoId" FROM "Face");
