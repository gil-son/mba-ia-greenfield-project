# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos Module

Video upload, background processing, and delivery span three locations — treat them as one feature, not three independent ones: a change to the upload/delivery contract almost always touches all three.

- `src/videos/` — `VideosController` + `VideosService`: the 6 HTTP endpoints and all domain logic (draft creation, ownership, Visibility rule, job enqueueing).
- `src/storage/` — `StorageService`: the only allowed entry point to S3/MinIO. Never instantiate `S3Client` or call the AWS SDK directly from `videos/` or `worker/` code — go through this service.
- `src/worker/` + `src/worker.ts` — the dedicated background worker: a **separate NestJS application context** (`NestFactory.createApplicationContext`, not `NestFactory.create`), bootstrapped independently of the HTTP API and run as its own Compose service (`video-worker`, `command: node dist/worker.js`). Do not assume `VideosController`/`VideosService` and the worker share a running process — they communicate only through the DB and the queue.

**Before changing any behavior in this module** (upload flow, queue/retry config, storage key scheme, or the streaming/download delivery mechanism), read `docs/decisions/technical-decisions-phase-03-videos.md`. It records the *why* — e.g. why client-driven S3 multipart upload was chosen over relaying bytes through the API, why BullMQ+Redis over the alternatives considered, why presigned-URL redirects over API-side range handling for streaming. Do not re-derive or override those decisions without checking that document first; if a change genuinely contradicts a recorded decision, flag it to the user rather than silently diverging.

### Endpoints (`VideosController`, `src/videos/videos.controller.ts`)

| Method | Route | Auth | Responsibility |
|---|---|---|---|
| POST | `/videos` | Authenticated | Validate `fileSizeBytes` (≤ 10GB) / `mimeType`, create the `draft` row owned by the caller's channel, start an S3 multipart upload, return per-part presigned PUT URLs |
| POST | `/videos/:id/complete-upload` | Owner | Complete the multipart upload with the given part ETags, flip status to `processing`, enqueue `video.process` |
| POST | `/videos/:id/abort-upload` | Owner | Abort the multipart upload, delete the draft row |
| GET | `/videos/:id` | Optional (Visibility rule) | Return status/metadata; populate `thumbnailUrl` only when `status === 'ready'` |
| GET | `/videos/:id/stream` | Optional (Visibility rule) | `302` to a presigned GET URL — no custom Range handling in the API, object storage answers byte-range requests natively |
| GET | `/videos/:id/download` | Optional (Visibility rule) | `302` to a presigned GET URL with `Content-Disposition: attachment` |

Keep all domain logic in `VideosService` — the controller must only call the service and map its result/exceptions to an HTTP response. If you add a 7th endpoint here, follow this same split.

### Visibility rule — enforce identically on every read endpoint above

- `status === 'ready'` → anonymous-readable, unconditionally.
- `status` in `draft` / `processing` / `failed` → **owner only**. Every other requester (anonymous, or a different authenticated user) must get `404 VIDEO_NOT_FOUND` — never a partial or reduced payload. Existence is masked; do not leak that a non-ready video exists to anyone but its owner.
- Exception: the owner requesting `/stream` or `/download` on a non-ready video gets `409 VIDEO_NOT_READY` instead of a mask — masking only applies to non-owners.
- Put this branching in `VideosService.findVisibleById` (reused by `getStreamUrl`/`getDownloadUrl` through the private `findReadyVisibleOrThrow` helper) — never duplicate the status/ownership check in the controller or in a guard.
- Use `@OptionalAuth()` (`src/auth/decorators/optional-auth.decorator.ts`) on these routes, not `@Public()`: it still decodes a bearer token when present (so ownership can be resolved) but does not reject the request when the header is missing or invalid — `request.user` becomes `null` instead of triggering a `401`. Read it with `@CurrentUserOrNull()` (`src/auth/decorators/current-user-or-null.decorator.ts`), never `@CurrentUser()`, on any `@OptionalAuth()` route.

### Async processing — queue + dedicated worker

- Never process video files inline in the HTTP request/response cycle. `VideosService.completeUpload` only enqueues a job; all FFmpeg work happens in the worker.
- Queue: BullMQ, queue name `video-processing`, backed by the `redis` Compose service (`@nestjs/bullmq`). Job name `video.process`, payload `{ videoId, objectKey }`, `attempts: 3` with exponential backoff — do not enqueue without these retry options, they are load-bearing for the failure-handling rule below.
- Consumer: `VideoProcessingProcessor` (`src/worker/video-processing.processor.ts`) — a `WorkerHost` subclass decorated `@Processor('video-processing')`. This is the `@nestjs/bullmq` (BullMQ-native) API; do not introduce the legacy `@nestjs/bull` `@Process()` decorator.
- **Never write `status = 'failed'` on the first error.** `VideoProcessingProcessor.onFailed` (`@OnWorkerEvent('failed')`) only marks a video `failed` once `job.attemptsMade >= job.opts.attempts` — a transient failure must be left to retry silently first. Preserve this guard in any change to the failure path.
- FFmpeg/ffprobe calls live only in `FfmpegService` (`src/worker/ffmpeg.service.ts`), which spawns the CLI binaries directly (no wrapper library) — `ffmpeg`/`ffprobe` must be present in the worker image's `PATH`. Keep the per-job temp-directory cleanup (`finally` block removing the `mkdtemp` dir) intact when touching this path.

### Object storage (`src/storage/`)

- All S3/MinIO access goes through `StorageService` (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `forcePathStyle: true` against the `minio` Compose service).
- Two buckets, created idempotently on boot: `videos` (originals), `thumbnails`. Keys follow `{channelId}/{videoId}/original.<ext>` and `{channelId}/{videoId}/thumbnail.jpg` — derive new keys from this pattern; do not invent a different key scheme.
- Upload bytes never pass through the API or worker process — presigned PUT URLs (client-driven S3 multipart upload) are the only upload path. Preserve this when extending the upload flow; do not add a code path that reads the file body server-side.
- Reads (stream/download/thumbnail) use `getPresignedGetUrl(bucket, objectKey, { expiresIn?, responseContentDisposition? })` — pass `responseContentDisposition: 'attachment'` only for forced downloads, never for streaming/thumbnails.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
