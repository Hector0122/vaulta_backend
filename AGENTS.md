# Vaulta — Context for AI assistants

## Project overview

Photo-sharing app: React Native frontend (Android) + NestJS backend + Neon (PostgreSQL) + Cloudflare R2 (S3-compatible storage). Server-side thumbnail generation via `sharp`, duplicate detection (perceptual hash), push notifications (Firebase), and email export via Mailgun.

## Project structure

```
PersonalProject/
├── AI_PLAN.md
├── vaulta_frontend/                # React Native 0.83.1
└── vaulta_backend/                 # NestJS 11 API <-- YOU ARE HERE
    ├── src/
    │   ├── main.ts                 # Bootstrap + CORS + 500MB body limit + PrismaModule
    │   ├── app.module.ts           # Root module (imports: Auth, Albums, Photos, Export, Analysis, Migration, Firebase, Common)
    │   ├── app.controller.ts       # Legacy routes
    │   ├── app.service.ts          # Legacy S3/sharp logic
    │   ├── prisma.module.ts        # Global PrismaModule (@Global()) — singleton, prevents duplicate connections
    │   ├── prisma.service.ts       # PrismaClient wrapper
    │   │
    │   ├── auth/                   # JWT auth + refresh tokens
    │   │   ├── auth.module.ts      # PassportModule + JwtModule + ThrottlerModule
    │   │   ├── auth.controller.ts  # POST /auth/login, /register, /refresh, /logout
    │   │   ├── auth.service.ts     # bcrypt hash/verify, JWT sign, refresh rotation (40B hex)
    │   │   ├── auth.service.spec.ts
    │   │   ├── jwt.strategy.ts     # Passport JWT strategy (no fallback secret)
    │   │   ├── jwt-auth.guard.ts   # @UseGuards(JwtAuthGuard)
    │   │   ├── current-user.decorator.ts  # @CurrentUser() param decorator
    │   │   ├── skip-auth.decorator.ts     # @SkipAuth() for public routes (e.g. /photos/:id/stream)
    │   │   └── dto/                # LoginDto, RegisterDto, RefreshTokenDto, UpdateProfileDto
    │   │
    │   ├── albums/                 # Album CRUD with many-to-many Photo relation
    │   │   ├── albums.module.ts
    │   │   ├── albums.controller.ts
    │   │   └── albums.service.ts
    │   │
    │   ├── photos/                 # Photo management (bulk of endpoints)
    │   │   ├── photos.module.ts
    │   │   ├── photos.controller.ts  # 20+ endpoints
    │   │   ├── photos.service.ts     # Business logic (+ bulkSetPrivate)
    │   │   └── upload.worker.ts      # Worker thread: S3 upload, sharp thumbnails, ffmpeg video thumbs, perceptual hash
    │   │
    │   ├── export/                 # ZIP export + email via Mailgun
    │   │   ├── export.module.ts
    │   │   ├── export.controller.ts  # POST /photos/export, /albums/:id/export, /photos/export-by-date, GET /exports/:id
    │   │   ├── export.service.ts     # In-memory export state, spawns worker, sends push notification on completion
    │   │   ├── export.worker.ts      # Worker thread: download from R2, archiver ZIP, upload to R2, email via Mailgun
    │   │   └── export.types.ts       # ExportProgress interface
    │   │
    │   ├── analysis/               # Image analysis (perceptual hash)
    │   │   ├── analysis.module.ts
    │   │   └── analysis.service.ts     # computePerceptualHash (delegates to common/image-analysis.ts)
    │   │
    │   ├── migration/              # S3 → DB migration utilities
    │   │   ├── migration.module.ts
    │   │   ├── migration.controller.ts  # 5 endpoints
    │   │   └── migration.service.ts     # syncS3ToDb, generateMissingThumbnails, migrateToFolders, fixVideoThumbnails, migrateVault
    │   │
    │   ├── firebase/               # Push notifications (Firebase Admin SDK)
    │   │   ├── firebase.module.ts
    │   │   ├── firebase.service.ts     # sendToUser(userId, payload), sendToAllUsers
    │   │   └── device-token.controller.ts  # POST /device-token
    │   │
    │   ├── faces/                  # Face detection & recognition (face-api + sharp)
    │   │   ├── faces.module.ts
    │   │   ├── faces.controller.ts     # 13 endpoints: CRUD faces, people, photos by person, stats
    │   │   ├── faces.service.ts        # Detection via child process, euclidean grouping
    │   │   ├── face-detect.mjs         # ESM child process: face-api + sharp image decode
    │   │   └── dto/
    │   │
    │   └── common/                 # Shared modules
    │       ├── constants.ts         # Centralized constants (thumb 400px/70%, ALLOWED_MIMES, etc.)
    │       ├── image-analysis.ts    # computePerceptualHash
    │       ├── s3.module.ts
    │       ├── s3.provider.ts      # S3 client factory (R2 if R2_ACCOUNT_ID set, else AWS) + getBucketName()
    │       ├── sanitize.ts          # Sanitization utilities
    │       └── exception.filter.ts # Global catch-all filter
    │
    ├── scripts/
    │   ├── bulk-upload.ts          # Bulk upload from external drive
    │   ├── clean-dups.ts           # Clean R2 duplicates
    │   ├── clean-r2.ts             # Manage R2 objects
    │   ├── count-r2.ts             # Count R2 objects
    │   └── db-r2-diff.ts           # Compare R2 vs DB records
    ├── prisma/
    │   ├── schema.prisma          # 5 models: User, Photo, Album, DeviceToken, Face
    │   ├── seed.ts                # Demo user (configurable via DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME)
    │   └── migrations/            # 15 SQL migrations
    │
    └── prisma.config.ts           # DATABASE_URL config
```

## Key technical decisions

- **adb reverse tcp:3000 tcp:3000** — device reaches backend via USB
- **Server-side thumbnails** via `sharp` (400px, 70% quality, EXIF-rotated) + `fluent-ffmpeg` for videos
- **Perceptual hash**: 8x8 grayscale, average-threshold, 64-bit hex for duplicate detection
- **Face detection**: TinyFaceDetector via `@vladmandic/face-api` running in ESM child process (`.mjs`), image decoding via `sharp`, face descriptors (FaceNet 128-dim) stored as JSON, euclidean distance < 0.6 for grouping. Models bundled in repo at `models/face-api/`
- **Worker threads** (`upload.worker.ts`, `export.worker.ts`) — CPU-heavy tasks off main thread
- **S3/R2**: auto-detects Cloudflare R2 if `R2_ACCOUNT_ID` set, else falls back to AWS S3
- **Mailgun** for export emails (not nodemailer)
- **Refresh token rotation**: 40-byte hex, hashed in DB, one-time use
- **500MB** max file size (not 20MB)
- **Gradle 8.13** required (9.0.0 has `IBM_SEMERU` `NoSuchFieldError` with JDK 21)

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Neon PostgreSQL |
| `JWT_SECRET` | ✅ | — | No fallback — app crashes if missing |
| `R2_ACCOUNT_ID` | ✅ | — | Cloudflare R2 account |
| `R2_ACCESS_KEY_ID` | ✅ | — | R2 access key |
| `R2_SECRET_ACCESS_KEY` | ✅ | — | R2 secret key |
| `R2_BUCKET_NAME` | ✅ | — | R2 bucket |
| `R2_PUBLIC_URL` | ✅ | — | R2 public URL |
| `DEMO_EMAIL` | ❌ | `demo@vaulta.com` | Demo account email |
| `DEMO_PASSWORD` | ❌ | `123456` | Demo account password |
| `DEMO_NAME` | ❌ | `Demo User` | Demo account name |
| `AUTO_SYNC_S3` | ❌ | — | Set to `true` to sync S3 on startup |
| `MAILGUN_API_KEY` | ❌ | — | For email export |
| `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` | ❌ | — | Alternative to Mailgun |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | ❌ | — | Firebase Admin SDK credentials (JSON string) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | ❌ | — | Or path to JSON file |

## Common commands

### Backend
```bash
cd vaulta_backend
npm run build          # compile TS
npm run start:dev      # watch mode on :3000
npm run test           # run tests
```

### Frontend
```bash
cd vaulta_frontend
yarn start             # Metro bundler on :8081
yarn android           # build + install APK
npx tsc --noEmit       # type-check
```

### Device connection
```bash
adb devices
adb reverse tcp:3000 tcp:3000
```

## Important gotchas

- Backend must be restarted after every change (`npm run build` + restart)
- `adb reverse` must be re-run after USB disconnect
- All `/photos/*` routes require JWT Bearer except `GET /photos/:id/stream` (has `@SkipAuth`, accepts token as `?token=` query param)
- `GET /photos` paginates via Prisma cursor (photo `id`), not S3 ContinuationToken
- `GET /photos/trash` returns soft-deleted photos (`deletedAt != null`)
- `POST /photos/sync-s3` imports existing S3 photos into DB (assigned to first user)
- Migration endpoints: `migrate-thumbnails`, `migrate-folders`, `sync-s3`, `fix-video-thumbnails`, `migrate-vault`
- `POST /device-token` upserts FCM tokens (findFirst + create/update — avoids Prisma v7 composite key issue)
- `DELETE /photos/trash/:id` permanently deletes from S3 + DB (no recovery)
- `DELETE /photos/:id` is soft-delete (sets `deletedAt`), can be restored via `POST /photos/:id/restore`
- Export worker uses Mailgun. If Mailgun is not configured, it falls back to SMTP env vars.
- `GET /photos/:id/stream` supports byte-range for video seeking
- CORS: `origin` from env var or `true` (not `'*'`), `credentials: false`

## Recent changes

- Moved from single `app.service.ts` to modular architecture: `photos/`, `export/`, `analysis/`, `migration/`, `firebase/`, `common/`
- Worker threads for upload processing (thumbnails, hash) and export (ZIP, email)
- Video support: thumbnails via ffmpeg, byte-range streaming, `ALLOWED_MIMES` includes video types
- Firebase push notifications: `DeviceToken` model, `sendToUser()`, triggered on export completion
- Mailgun integration for export email (replaced nodemailer)
- 500MB file size limit (was 20MB)
- 14 database migrations (from init to add_performance_indexes)
- SkipAuth decorator for public stream endpoint
- Global exception filter
- **Optimización código**: `computeBlurScore`/`computePerceptualHash` extraídos a `common/image-analysis.ts`, `fetchWithTimeout` extraído a util compartido, constantes centralizadas en `common/constants.ts` (604800, 300, 70, etc.)
- **Bulk private**: `PATCH /photos/bulk-private` + UI en selección múltiple
- **Vault albums**: sub-álbumes dentro de la Caja Fuerte, `listVaultAlbums()`
- **Autenticación biométrica**: FaceID/huella para Vault
- **Todos los bugs solventados**: ffmpeg en Railway, pantalla negra offline, auto-delete papelera, 401 en stream download
- **Nuevos scripts**: `scripts/` — bulk-upload, clean-dups, clean-r2, count-r2, db-r2-diff
- **Reconocimiento facial**: Detección de caras con face-api + sharp, descriptor FaceNet 128-dim, agrupación euclidiana, modelo `Face` en Prisma, auto-detección al subir fotos, People Browser UI, búsqueda/filtro por persona, memorias por persona, stats faciales
- **Quitar cara de foto**: `DELETE /faces/by-photo/:photoId?person=:name` — elimina una cara específica de una foto sin borrar la foto
- **Respuesta album photos**: `GET /albums/:id/photos` devuelve `{ photos: [...], nextToken }` (objeto envuelto con paginación), no array plano
- **Grid unificado**: PersonView, AlbumView y find-more modal usan el mismo patrón de grid — manual rows + `flex:1` + `aspectRatio:1` + `overflow:hidden`
- **AlbumView fix**: frontend ahora parsea correctamente `{ photos }` en vez de esperar array plano
- **People card redesign**: thumbnail 56px, sombra/elevación, sin borde ni chevron, botón de búsqueda sin background tint
- **Multi-tag modal**: input de chips para asignar múltiples nombres a una cara, sin diálogo de confirmación
- **Navegación desde caras no confirmadas**: thumbnail en People → PhotoPreview
- **Find-more selección**: checkboxes individuales, badge de distancia, toolbar "Seleccionar todas/Deseleccionar"
- **PhotoPreview blur fix**: `setImageReady(true)` al cargar fotos desde PersonView

## Scripts (`scripts/`)

| Script | Descripción |
|---|---|
| `scan-local.ts` | Face detection masiva desde CPU local (descarga de R2, detecta con face-api, hace matching con personas confirmadas, envía resultados a la API) |
| `bulk-upload.ts` | Subida masiva desde disco externo a R2 + DB con dedup por hash perceptual |
| `generate-video-thumbnails.ts` | Genera thumbnails de video faltantes (ffmpeg) |
| `count-r2.ts` | Cuenta objetos en R2 |
| `db-r2-diff.ts` | Compara DB vs R2 |
| `fix-db-r2-diff.ts` | Repara discrepancias DB/R2 |
| `clean-r2.ts` | Elimina objetos en R2 por prefijo |

### `scan-local.ts` — Face detection masiva

Escanea fotos pendientes (sin caras detectadas) usando CPU local. Descarga cada foto de R2 a temp, corre face-api.js, hace matching euclidiano contra encodings confirmados, y envía resultados a `POST /faces/ingest`.

**Flags:**
| Flag | Default | Descripción |
|---|---|---|
| `--max-photos <N>` | ∞ | En fresh start: procesa N fotos totales. En resume: procesa N fotos **adicionales** al checkpoint. |
| `--resume` | auto | Fuerza reanudar desde checkpoint (auto si existe `scan-state.json`). |
| `--no-resume` | — | Ignora checkpoint y empieza de cero (borra `scan-state.json` internamente). |
| `--take <N>` | 100 | Fotos por página del endpoint `GET /faces/pending`. |
| `--batch <N>` | 50 | Fotos por request a `POST /faces/ingest` (max 100). |
| `--concurrency <N>` | 3 | Descargas concurrentes (1-5). |
| `--dry-run` | — | No envía resultados, solo muestra lo que se enviaría. |

**Paginación:** usa `?page=N&take=100` (offset-based) en vez de cursor. Esto evita que el script se atasque cuando una foto cursor deja de estar en pending tras ser procesada.

**Checkpoint:** guarda estado en `scan-state.json` (processedIds, totalProcessed, totalFaces, failedIds). Al reanudar, salta las fotos ya procesadas usando `processedIds` (sin depender de cursores). El flag `--max-photos` es **incremental** en modo resume: pides N fotos nuevas, no un total acumulado.

**Ejemplos:**
```bash
# Primera ejecución: procesar 1000 fotos
pnpm tsx scripts/scan-local.ts --max-photos 1000

# Reanudar y procesar 500 más
pnpm tsx scripts/scan-local.ts --max-photos 500

# Empezar de cero (ignorar checkpoint)
pnpm tsx scripts/scan-local.ts --max-photos 1000 --no-resume

# Prueba sin enviar nada
pnpm tsx scripts/scan-local.ts --max-photos 5 --dry-run
```

## Coding conventions

- TypeScript, strict mode
- NestJS decorators for routes/DI
- No semicolons where possible, 2-space indent
- No inline comments in code (unless absolutely necessary)
