-- Covered by composite indexes that start with the same columns
DROP INDEX IF EXISTS "Photo_userId_idx";
DROP INDEX IF EXISTS "Photo_userId_deletedAt_idx";
DROP INDEX IF EXISTS "Face_confirmed_ignored_idx";

-- btree can't serve `contains`/`startsWith` queries on these
DROP INDEX IF EXISTS "Photo_filename_idx";
DROP INDEX IF EXISTS "Photo_mimeType_idx";

-- `tags has x` needs GIN, not btree
DROP INDEX IF EXISTS "Photo_tags_idx";
CREATE INDEX "Photo_tags_idx" ON "Photo" USING GIN ("tags");
