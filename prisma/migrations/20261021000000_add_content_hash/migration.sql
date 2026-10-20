-- AlterTable
ALTER TABLE "Photo" ADD COLUMN "contentHash" TEXT;

-- CreateIndex
CREATE INDEX "Photo_userId_contentHash_idx" ON "Photo"("userId", "contentHash");
