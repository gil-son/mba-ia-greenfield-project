---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-18
scope_description: "Video upload and background processing: message queue technology, large-file (≤10GB) upload strategy, object storage usage (buckets/keys/presigned URLs), video worker execution model, FFmpeg-based metadata/thumbnail extraction, streaming/download delivery, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

> **Note on sourcing:** Library research was originally drafted using the npm registry and direct fetches of official docs, since `context7` was not reachable in that session. It has since been **revalidated via the `context7` MCP** (per `CLAUDE.md`'s documentation-lookup rule) against `/taskforcesh/bullmq`, `/nestjs/docs.nestjs.com` (BullMQ techniques page), `/aws/aws-sdk-js-v3`, and `/fluent-ffmpeg/node-fluent-ffmpeg`, cross-referenced against `nestjs-project`'s installed stack (NestJS `11.0.x`, Node `25.6.0-slim`, PostgreSQL 17). All API usages (`@Processor`/`WorkerHost`/`@OnWorkerEvent`, `CreateMultipartUploadCommand`/`UploadPartCommand`/`CompleteMultipartUploadCommand`/`AbortMultipartUploadCommand`, `getSignedUrl`) and the `fluent-ffmpeg` deprecation claim in TD-05 were confirmed as written — no recommendation changes resulted from this pass. npm registry version numbers cited throughout (`@nestjs/bullmq@11.0.5`, `bullmq@6.1.2`, `@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner@3.1113.0`, `fluent-ffmpeg@2.1.3`) were re-checked and are unchanged.

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the entire Phase 03 surface: upload initiation, video draft persistence, queue producer, video worker (metadata/thumbnail processing), object storage integration, and streaming/download endpoints.
- `next-frontend/` — Frontend deferred: the upload UI, progress indicator, and video player consuming the streaming/download URLs are out of scope for this phase (per phase checklist, backend-only). Will be addressed when the frontend catches up to Phase 03+ in a future phase. No open decision in this document. The upload/streaming contracts decided here (TD-02, TD-06) become the constraints that phase's frontend TDs must consume.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** `docs/project-plan.md`'s architecture section lists "Message Queue (TBD)" as an explicit open container — this is the phase's primary stack decision. Video processing (metadata extraction, thumbnail generation) is CPU-bound and must not run inline in the HTTP request/response cycle, so completed uploads need to be handed off to a background job system that a separate worker consumes. The project currently has no queue/broker infrastructure — only PostgreSQL, Mailpit, and (from this phase on) an object storage service.

**Options:**

### Option A: BullMQ + Redis (via `@nestjs/bullmq`)
- Redis-backed job queue. `Queue` (producer) enqueues jobs; `Worker`/`Processor` classes consume them. `@nestjs/bullmq` (latest `11.0.5`, published 2026-08-07) declares peer ranges `@nestjs/core`/`@nestjs/common` `^10.0.0 || ^11.0.0` and `bullmq ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0` — directly compatible with the installed NestJS `11.0.x`. `bullmq` itself is at `6.1.2`.
- **Pros:** Purpose-built for this exact use case (background job processing with retries/backoff/progress/concurrency, delayed and prioritized jobs). Official, actively maintained NestJS module with `@Processor`/`WorkerHost`/`@OnWorkerEvent` decorators — first-class DI integration. Matches the C4 diagram's dedicated "Message Queue" container literally (a real, visible new service in `compose.yaml`, not infra reuse). Largest ecosystem/community for exactly this "upload → background transcode/probe" pattern.
- **Cons:** Adds a brand-new infrastructure dependency (Redis) the project has never run before — a new `compose.yaml` service, new env vars, another moving part in local dev.

### Option B: RabbitMQ (via `@nestjs/microservices` RMQ transport)
- AMQP broker. NestJS's official RMQ transport wraps `amqplib`; producers use `ClientProxy.emit()` (fire-and-forget) and consumers use `@EventPattern()` handlers in a hybrid/microservice app.
- **Pros:** Battle-tested broker for cross-service pub/sub at scale; would fit well if the platform later needs multiple independent consumers per event (e.g., fan-out to analytics + processing + notifications).
- **Cons:** NestJS's RMQ transport is oriented at request/response (`send()`) or simple event fan-out (`emit()`) between *microservices*, not job-queue concerns like per-job retry count, exponential backoff, progress reporting, or delayed jobs — those would need to be hand-rolled on top of raw AMQP. Heavier operational footprint (management UI, exchanges/queues/bindings to configure) than this single-consumer, single-producer use case justifies. Yet another new infra dependency, with less direct fit than Option A.

### Option C: pg-boss (Postgres-native queue)
- Job queue implemented entirely on top of PostgreSQL, using `SELECT ... FOR UPDATE SKIP LOCKED`. Latest `12.27.0`. Requires Node `≥22.12` (satisfied by the installed `node:25.6.0`) and Postgres `≥13` (satisfied by the installed `postgres:17`). Ships retries with backoff, dead-letter queues, cron scheduling, and an optional dashboard package.
- **Pros:** Zero new infrastructure — reuses the PostgreSQL instance already in the stack; no new `compose.yaml` service, no new operational surface for a project of this scale.
- **Cons:** Adds job-queue read/write load to the same database instance serving all other domain queries (contention risk as video volume grows). Diverges from the architecture diagram's explicit "Message Queue" as its own container — an evaluator reading the diagram/compose would not see a distinct queue service materialize. Smaller ecosystem/mindshare specifically for media-processing pipelines compared to BullMQ.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — it is the only option purpose-built for retryable, progress-tracked background jobs (fits TD-07's retry/backoff needs directly), has an official NestJS integration already compatible with the installed Nest 11, and materializes the architecture diagram's "Message Queue" container as a real, visible service — which the phase's own checklist treats as a deliverable ("Fila, worker ou storage não subindo de verdade no Compose" is listed as an automatic-fail condition). Redis is a lightweight, well-understood addition to local Docker Compose.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: Video Upload Strategy for Files up to 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The phase requires accepting uploads up to 10GB "sem impacto na performance." NestJS's default upload path (`@nestjs/platform-express` + Multer) buffers/streams the multipart body through the API process — for a single-instance Node API, having every upload's bytes flow through the same process that serves all other HTTP traffic (auth, video listing, etc.) for however long a 10GB transfer takes is exactly the "travar a API" failure mode the phase explicitly guards against. Depends on TD-03 (which storage client/SDK issues the presigned URLs).

**Options:**

### Option A: Presigned multipart upload direct to object storage
- API creates the video draft row and calls the storage SDK's `CreateMultipartUpload`, returning the `uploadId` plus a presigned URL per part (S3/MinIO multipart parts: up to 5GB each, so a 10GB file needs ≥2 parts) to the caller. The caller (browser or any client) `PUT`s each part directly to MinIO using those URLs, then calls a backend "complete" endpoint with the collected part ETags, which triggers `CompleteMultipartUpload` and enqueues the processing job (TD-01).
- **Pros:** Video bytes never touch the NestJS process — the API's involvement per upload is O(few small JSON calls), regardless of file size. Directly satisfies "sem impacto na performance." Multipart is the standard mechanism for objects beyond the single-PUT size ceiling (5GB on S3-compatible APIs), so it is also the only option that cleanly supports the full 10GB requirement per object.
- **Cons:** More moving parts than a single presigned PUT: the API must persist the `uploadId`/part plan against the draft video row and expose a "complete" endpoint; partial/aborted uploads need cleanup (`AbortMultipartUpload`) or a TTL/lifecycle policy on stale drafts.

### Option B: Streaming proxy through the NestJS API (Multer/stream piped to storage)
- The client `POST`s the raw file to a NestJS endpoint; Multer (or a manual `busboy` pipe) streams the incoming request body directly into a `putObject` call against MinIO, without buffering the whole file in memory.
- **Pros:** Single endpoint, no client-side orchestration of parts/ETags — simplest client contract.
- **Cons:** The API process still owns the full duration of every upload's I/O (an HTTP connection and Node event-loop I/O slot held open for as long as a 10GB transfer over the client's network takes), competing with all other concurrent API traffic and with reverse-proxy/timeout defaults tuned for sub-second requests. This is precisely the pattern the phase capability wording warns against ("sem impacto na performance").

### Option C: tus resumable upload protocol
- Client and server speak the open `tus` protocol (chunked, resumable uploads that survive connection drops), typically via a `tus` server component (e.g. `@tus/server`) sitting in front of storage.
- **Pros:** Best resilience for very large files over unreliable networks — uploads can resume from the last acknowledged offset instead of restarting.
- **Cons:** MinIO/S3 has no native `tus` support; a `tus` server is yet another process that still relays every byte through infrastructure the project runs (either the API or a dedicated new service), reintroducing the same "bytes flow through our infra" cost Option A avoids entirely. Adds a new protocol/dependency for a resilience property (mid-transfer resume) the phase's capability list does not ask for.

**Recommendation:** **Option A (Presigned multipart upload direct to object storage)** — it is the only option where a 10GB upload has zero throughput cost on the API process, matching the capability's explicit "sem impacto na performance" wording, and multipart is the mechanism that actually makes objects of that size possible against an S3-compatible API in the first place.

**Decision:** A (Presigned multipart upload direct to object storage)

---

## TD-03: Object Storage Client & Bucket/Key Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "URL única por vídeo, sem conflito com outros vídeos"

**Context:** MinIO (S3-compatible) is already fixed as the object storage backend (not an open decision) — what remains open is which Node.js SDK talks to it, and how buckets/keys are organized so every video gets a unique, collision-free URL. This decision is a prerequisite for TD-02 (presigned multipart upload requires SDK support for `CreateMultipartUpload`/per-part presigning) and TD-06 (streaming/download presigned GET URLs).

**Options:**

### Option A: `minio` official JS SDK
- First-party client purpose-built for MinIO. Latest `8.0.7`. Exposes `presignedPutObject`/`presignedGetObject` for single-object presigning directly.
- **Pros:** Built by the MinIO team, simplest API for the single-object presign case, no endpoint-compatibility workarounds needed.
- **Cons:** Its public API is oriented around whole-object presigned PUT/GET; per-part presigned URLs for a client-driven multipart upload (TD-02 Option A) are not a first-class, well-documented surface of this SDK the way they are in the AWS SDK — would likely require dropping to lower-level/undocumented calls to presign individual `UploadPart` requests.

### Option B: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (AWS SDK v3), pointed at MinIO
- AWS's official modular S3 client (latest `3.1113.x`), configured with a custom `endpoint` (the MinIO service) and `forcePathStyle: true`. Since MinIO implements the S3 API, every command works unmodified: `CreateMultipartUploadCommand`, `UploadPartCommand` (presigned per part via `getSignedUrl`), `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, and single-object `PutObjectCommand`/`GetObjectCommand` presigning.
- **Pros:** Full, well-documented native support for exactly the presigned-multipart flow TD-02 needs (this is the reference implementation multipart-presigning examples across the ecosystem are built on). Portable: if the project ever moves from MinIO to real AWS S3 in production — which the architecture diagram already anticipates ("Object Storage (S3/MinIO)") — no client code changes, only endpoint/credentials config.
- **Cons:** Heavier package (modular but still a larger surface than the `minio` SDK) for the subset of the API actually used; AWS-flavored naming/config (`forcePathStyle`, region handling) has a small learning curve when the target is not actually AWS.

### Option C: Both SDKs — `minio` for bucket lifecycle/admin, AWS SDK v3 for presigning
- Use the `minio` SDK only for bucket creation/policy setup, and AWS SDK v3 purely for the presigned multipart flow.
- **Pros:** Each library used for the part of the API it documents best.
- **Cons:** Two S3-compatible client dependencies for overlapping responsibility (both can create buckets and set policies) — unnecessary surface area and two sets of client config/credentials to keep in sync for no functional gain.

**Recommendation:** **Option B (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)** — TD-02's presigned multipart upload is the flow this decision must support cleanly, and it is a first-class, thoroughly documented capability of the AWS SDK, not of the MinIO-specific client. It also keeps the storage client itself S3-generic, aligned with the architecture diagram's own framing of the container as "Object Storage (S3/MinIO)" rather than MinIO-specific.

**Bucket/key strategy:** two buckets — `videos` (originals) and `thumbnails` — with keys namespaced `{channelId}/{videoId}/original.<ext>` and `{channelId}/{videoId}/thumbnail.jpg`. Since `videoId` is a UUID primary key generated at draft creation (TD-07), the key is unique by construction — no collision handling needed. The video's single "URL" (capability requirement) is derived by presigning a GET against this fixed key on demand (TD-06), not by storing a public URL string.

**Decision:** B (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)

---

## TD-04: Video Worker Execution Model

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Video processing (FFmpeg metadata/thumbnail extraction, TD-05) is CPU-intensive and must run outside the NestJS API's own process/container so a burst of uploads cannot starve request handling — this is the "processo/container separado" the phase explicitly calls for. The decision is how that separation is implemented given the project is a single-repo monorepo with no workspace tooling.

**Options:**

### Option A: Dedicated worker entrypoint inside `nestjs-project/`, own Compose service
- Add a second bootstrap file (e.g., a `NestFactory.createApplicationContext` entrypoint) in the same `nestjs-project/` codebase that registers only the video/queue/storage modules and starts a BullMQ `Worker`/`@Processor`. The existing Docker image is reused with a different container command, declared as a new `video-worker` service in `compose.yaml` (its own container/process, same image).
- **Pros:** Full code/DI reuse — TypeORM entities, config module (`registerAs` namespaces), and video domain services are shared with the API with zero duplication. Genuinely separate OS process/container (satisfies the phase's literal requirement) while staying inside the existing monorepo layout — no new workspace tooling needed. Independently restartable/scalable in Compose without touching the API container.
- **Cons:** Same Docker image/build for two different runtime roles (API vs worker) — the worker container carries dependencies (e.g., `@nestjs/platform-express`) it does not need, and its Dockerfile needs `ffmpeg`/`ffprobe` installed (TD-05) even though the API image does not.

### Option B: Fully separate subproject with its own `package.json`
- A new top-level directory (e.g., `video-worker/`) with an independent Node project, duplicating the entity/config shapes it needs from `nestjs-project/`.
- **Pros:** Cleanest deployment boundary — the worker's dependency tree and Dockerfile are minimal and purpose-built from the start.
- **Cons:** No workspace/monorepo tooling exists in this repo (per `CLAUDE.md`, that decision has not been made) — sharing the `Video` entity shape, DTOs, and config between two independent `package.json`s means hand-duplicating and manually keeping them in sync, a real drift risk for a Single-Responsibility-conscious project already emphasizing avoiding duplicated domain logic across modules.

### Option C: BullMQ sandboxed processors inside the API process
- Register the BullMQ `Worker` in the same NestJS application as the API, using BullMQ's "sandboxed processors" feature (each job runs in an isolated child process spawned by BullMQ itself via a processor file path), so heavy jobs don't block the API's own event loop.
- **Pros:** No new Compose service to configure; job isolation is real (a separate OS process per job).
- **Cons:** The isolation is per-job, not per-deployment — the worker's resource consumption (and its `ffmpeg`/`ffprobe` binary dependency) still lives inside the API's container/image and scales/restarts coupled to the API, contradicting the phase's explicit ask for a separate container and making the API image responsible for FFmpeg tooling it otherwise would never need.

**Recommendation:** **Option A (dedicated worker entrypoint in `nestjs-project/`, own Compose service)** — it is the only option that gives a genuinely separate container/process (as the phase requires) without introducing monorepo/workspace tooling the project has not adopted, while still sharing the domain code (entities, config, video services) that both the API and worker need — avoiding the duplication risk of Option B.

**Decision:** A (Dedicated worker entrypoint in `nestjs-project/`, own Compose service)

---

## TD-05: FFmpeg Integration for Metadata Extraction & Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The video worker (TD-04) needs to run `ffprobe` (duration/codec/metadata) and `ffmpeg` (extract one frame as a thumbnail) against the uploaded file. The question is whether to use a Node.js wrapper library around these CLIs or invoke them directly.

**Options:**

### Option A: `fluent-ffmpeg`
- The long-standing community wrapper providing a chainable API over the `ffmpeg`/`ffprobe` binaries, plus a `.screenshots()` helper for frame extraction.
- **Pros:** Familiar, widely referenced in tutorials; chainable API reads well for simple cases.
- **Cons:** **Confirmed via the npm registry: the latest version (`2.1.3`, published 2024-05-19) carries an explicit deprecation notice — "Package no longer supported."** The project's own GitHub repository is archived (as of May 2025) with the maintainers stating it "no longer works properly with recent ffmpeg versions." Adopting it now means starting Phase 03 on a dependency that is already known-broken against current FFmpeg releases, with no upstream fixes possible.

### Option B: Direct `child_process` invocation of the `ffmpeg`/`ffprobe` binaries
- Use Node's built-in `child_process.execFile`/`spawn` to run `ffprobe -v quiet -print_format json -show_format -show_streams <file>` (parse the JSON stdout for duration/codec/resolution) and `ffmpeg -i <file> -ss <timestamp> -vframes 1 <output.jpg>` (single-frame thumbnail). No wrapper dependency — the worker's Dockerfile installs `ffmpeg` (which bundles `ffprobe`) via the system package manager.
- **Pros:** Zero dependency risk — `child_process` is Node core, and the actual FFmpeg project (the CLI itself) is actively maintained; only the exact commands the worker needs are implemented, with full control over flags. Avoids repeating Option A's mistake of depending on an abandoned abstraction layer.
- **Cons:** More boilerplate than a fluent wrapper — argument arrays, stdout/stderr handling, and JSON parsing must be written by hand (though this is a small, self-contained module).

### Option C: A community fork/successor of `fluent-ffmpeg`
- Adopt one of the unofficial forks that have appeared since the original was archived.
- **Pros:** Would preserve the chainable API style if a fork proves reliable.
- **Cons:** No fork has the adoption, documentation, or track record to responsibly recommend for a project standard at this time; picking one would trade a known-deprecated dependency for an unvetted one, without solving the underlying maintenance-risk problem.

**Recommendation:** **Option B (direct `child_process` invocation)** — the npm registry confirms `fluent-ffmpeg` is deprecated and its own maintainers confirm breakage against recent FFmpeg versions, so Option A is disqualified outright; no vetted successor exists (Option C), and the worker's actual FFmpeg usage (one `ffprobe` call, one `ffmpeg` frame-extraction call) is small enough that a thin, explicit wrapper avoids both the abandoned-dependency risk and any wrapper abstraction entirely.

**Decision:** B (Direct `child_process` invocation of `ffmpeg`/`ffprobe`)

---

## TD-06: Video Streaming & Download Delivery Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Once a video is `ready` (TD-07), it must be playable via HTTP Range requests (so a player can seek without downloading the whole file) and downloadable. Depends on TD-03 (storage client) for how the URL is produced.

**Options:**

### Option A: NestJS controller relays the video, handling `Range` manually
- A backend endpoint reads the `Range` request header, issues a ranged `GetObjectCommand` against MinIO, and pipes the returned partial stream back to the client with `206 Partial Content`, `Content-Range`, and `Accept-Ranges` headers.
- **Pros:** The API stays in the request path for every byte, which would matter if per-request authorization/visibility checks (e.g., private/unlisted videos) needed to gate access to the stream itself.
- **Cons:** Reintroduces exactly the "bytes flow through the API process" cost that TD-02 deliberately avoided for uploads — now for every playback second and every download, for every viewer, including the anonymous, unauthenticated viewers the project plan explicitly supports from this phase's neighboring phases onward. Doesn't scale independently of the API.

### Option B: Presigned GET URL, client/player fetches directly from MinIO
- The backend returns a short-lived presigned GET URL (or the request that returns video details includes it); the browser's `<video>` element (or a plain download click) issues Range requests straight to MinIO, which — like any S3-compatible server — natively answers byte-range GETs with `206 Partial Content` without any custom backend code.
- **Pros:** Zero relay cost on the API for playback/download traffic, symmetric with TD-02's upload approach (bytes never traverse API infra in either direction). Range-request/seek support is inherited for free from MinIO's S3-API compliance — nothing to implement. Same mechanism serves both "streaming" and "download" (a normal file download is just a GET without partial range).
- **Cons:** Per-video access control (relevant once "unlisted" visibility ships in Phase 04/05) has to be enforced by scoping what the backend is willing to presign, not by a request-time check on every byte — an acceptable trade for now since the project plan states anonymous playback is unrestricted at this phase.

### Option C: Reverse proxy / CDN in front of MinIO
- Put Nginx or a CDN edge in front of MinIO to terminate Range requests and cache segments.
- **Pros:** Would add caching and edge distribution if traffic ever demanded it.
- **Cons:** New infrastructure component with no functional requirement behind it at this project's scale (single local MinIO instance, no CDN in the architecture diagram) — pure overhead for this phase.

**Recommendation:** **Option B (presigned GET URL, direct client-to-storage streaming)** — it mirrors TD-02's upload decision (keep bytes off the API), gets correct Range-request/206 behavior for free from MinIO's S3 compatibility instead of hand-rolled partial-content code, and serves both streaming and download capabilities with the same mechanism.

**Decision:** B (Presigned GET URL, direct client-to-storage streaming)

---

## TD-07: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Serviço de processamento em segundo plano (filas)"

**Context:** A video row is created as a draft the moment upload starts (before any bytes exist), then must reflect processing progress and terminal outcome. The phase must define the state set and what happens when worker processing (TD-04/TD-05) fails. Depends on TD-01 (BullMQ retry/backoff is only available if BullMQ is the chosen queue).

**Options:**

### Option A: Plain enum column, no automatic retry
- `status: draft | processing | ready | error` on the video entity. The API sets `draft` on upload initiation (TD-02) and `processing` once the multipart upload is confirmed complete and the job is enqueued; the worker sets `ready` on success or `error` (plus an `error_message` column) on any failure, with no automatic re-attempt — a failed video stays `error` until a human/future-phase action explicitly retries it.
- **Pros:** Simplest possible model — four states, one-directional writes, easy to reason about and test.
- **Cons:** Any transient failure (e.g., a momentary storage hiccup) permanently fails the video and needs an operator or a future re-upload; not resilient by itself.

### Option B: Enum column + queue-native automatic retry/backoff before `error`
- Same four states as Option A, but the worker's job is configured with BullMQ's built-in bounded retry count and exponential backoff (e.g., 3 attempts) — `status` only flips to `error` after all automatic attempts are exhausted, and to `ready` as soon as one attempt succeeds.
- **Pros:** Absorbs exactly the class of transient failures Option A leaves to chance, using a capability BullMQ already provides for free (no extra code beyond job options) — the video only ever reaches the user-facing `error` state after genuine, repeated failure. Still only four `status` values — no added modeling complexity over Option A.
- **Cons:** A persistently-failing job now retries a few times before surfacing `error`, adding a bounded delay to when a genuinely broken upload (e.g., corrupt file) is reported as failed — acceptable given the attempt count stays small.

### Option C: Explicit state-machine library with guarded transitions
- Model transitions with a formal state machine (e.g., `xstate` or a hand-rolled transition table) that validates every write against an allowed-transitions matrix, rejecting e.g. `ready → draft`.
- **Pros:** Strongest guarantee against illegal transitions being written by a future bug.
- **Cons:** Four linear states (`draft → processing → {ready|error}`) is not enough transition complexity to justify a dedicated state-machine dependency or hand-rolled guard matrix — the two writers (API on upload-start/confirm, worker on completion) are few enough that a plain enum with disciplined write sites already prevents the realistic mistakes.

**Recommendation:** **Option B (enum column + BullMQ automatic retry/backoff)** — it costs nothing beyond configuring job options already available once TD-01 (BullMQ) is chosen, and it is the only option that distinguishes a truly-failed video from a merely-transient hiccup without adding the transition-matrix overhead Option C would require for a state space this small.

**Decision:** B (Enum column + BullMQ automatic retry/backoff)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-02 | Backend | Video Upload Strategy (≤10GB) | Presigned multipart upload direct to object storage | A (Presigned multipart upload direct to object storage) |
| TD-03 | Backend | Object Storage Client & Bucket/Key Strategy | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | B (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) |
| TD-04 | Backend | Video Worker Execution Model | Dedicated worker entrypoint in `nestjs-project/`, own Compose service | A (Dedicated worker entrypoint in `nestjs-project/`, own Compose service) |
| TD-05 | Backend | FFmpeg Integration (metadata + thumbnail) | Direct `child_process` invocation of `ffmpeg`/`ffprobe` | B (Direct `child_process` invocation of `ffmpeg`/`ffprobe`) |
| TD-06 | Backend | Video Streaming & Download Delivery | Presigned GET URL, direct client-to-storage | B (Presigned GET URL, direct client-to-storage streaming) |
| TD-07 | Backend | Video Status Lifecycle & Failure Handling | Enum column + BullMQ automatic retry/backoff | B (Enum column + BullMQ automatic retry/backoff) |
