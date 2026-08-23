---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-19T20:26:50-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-19T20:25:50-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-19T20:18:39-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-16T18:30:32-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Implementar, em `nestjs-project/`, o backend de upload e processamento de vídeos da Fase 03: upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático do vídeo após upload (extração de duração e metadados), geração automática de thumbnail a partir de um frame do vídeo, URL única por vídeo sem conflito com outros vídeos, reprodução via streaming (sem necessidade de download completo) e download do vídeo pelo usuário — entregando upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Entidade Video e migration

**Description:** Criar a entidade `Video` e a migration correspondente, base de dados para todo o fluxo de upload e processamento da Fase 03.

**Technical actions:**

1. Criar `videos/entities/video.entity.ts` com os campos e o enum de `status` definidos em `### Data Model → Video` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-07`)
2. Criar migration TypeORM para a tabela `videos` (unique em `objectKey`, índice em `channelId`, índice em `status`) — seguindo a convenção `synchronize: false` herdada
3. Registrar `Video` no `VideosModule` via `TypeOrmModule.forFeature([Video])`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults (per Testing Requirements — Entity) | `videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A migration cria a tabela `videos` com constraint unique em `objectKey`
- Inserir um `Video` sem `channelId` falha por violação de not-null
- Um `Video` criado sem `status` explícito persiste com `status = 'draft'`

---

### SI-03.2 — Infra: fila de processamento (BullMQ + Redis)

**Description:** Provisionar o Redis no Compose e configurar o BullMQ para materializar a fila de processamento de vídeos (per `phase-03-videos/TD-01`).

**Technical actions:**

1. Adicionar o serviço `redis` ao `docker-compose.yml`
2. Criar `queue.config.ts` com `registerAs('queue', () => ({ host, port }))` — convenção `registerAs` herdada
3. Configurar `BullModule.forRootAsync` usando `queueConfig` via `ConfigType`
4. Registrar a fila `video-processing` via `BullModule.registerQueue({ name: 'video-processing' })` em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` (BullModule.registerQueue) | Unit: compilation test (per Testing Requirements — Module com configured imports) | `videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra o serviço `redis` com status `running`
- A aplicação inicializa sem erros com o `BullModule` conectado ao Redis do Compose
- `VideosModule` compila com a fila `video-processing` registrada

---

### SI-03.3 — Infra: cliente de object storage (AWS SDK v3)

**Description:** Criar o wrapper de object storage usado por todo o fluxo de upload/streaming/download, incluindo a estratégia de chave única por vídeo (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-06`).

**Technical actions:**

1. Criar `storage.config.ts` com `registerAs('storage', () => ({ endpoint, region, videosBucket, thumbnailsBucket, credentials }))` — convenção `registerAs` herdada
2. Criar `StorageService` com métodos `createMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload` e `getPresignedGetUrl` sobre o `S3Client` do AWS SDK v3, operando nos dois buckets decididos (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-06`)
3. Implementar a estratégia de bucket/chave decidida em `phase-03-videos/TD-03` — dois buckets, `videos` (originais) e `thumbnails`, com chaves `{channelId}/{videoId}/original.<ext>` e `{channelId}/{videoId}/thumbnail.jpg` respectivamente; unicidade garantida por construção via `videoId` (UUID)
4. Registrar `StorageService` em um `StorageModule` compartilhado, importado por `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real capture service / local adapter — MinIO (per Testing Requirements — Service com side-effect dep) | `storage/storage.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `StorageService.createMultipartUpload` retorna um `uploadId` válido e uma `objectKey` no formato `{channelId}/{videoId}/original.<ext>`, no bucket `videos` (per `phase-03-videos/TD-03`)
- Duas chamadas para vídeos distintos nunca geram a mesma `objectKey`, pois `videoId` é único por construção
- `StorageService.getPresignedGetUrl` retorna uma URL expirável válida contra o MinIO local, tanto para o bucket `videos` quanto para `thumbnails`

---

### SI-03.4 — Endpoint POST /videos (iniciar upload)

**Description:** Endpoint que pré-cadastra o vídeo como rascunho e inicia o multipart upload, devolvendo as URLs presigned das partes (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`).

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated (qualquer usuário autenticado cria vídeos sob o próprio canal)

**Technical actions:**

1. Criar `videos/dto/create-video.dto.ts` — `CreateVideoDto` com `originalFilename`, `fileSizeBytes` (máx. 10GB) e `mimeType` (per `### API Contracts → POST /videos`)
2. Criar `VideosService.initiateUpload(channelId, dto)` — deriva `title` de `originalFilename` (extensão removida), gera `objectKey`, cria o `Video` em `draft` e chama `StorageService.createMultipartUpload` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
3. Criar `VideosController.create` (`POST /videos`), protegido pelo guard de autenticação herdado (per `phase-02-auth/TD-02`), delegando para `VideosService.initiateUpload`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: branch logic — mock repo + mock StorageService (per Testing Requirements — Service com branching + DB) | `videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: DB contract — persiste `Video` em `draft` com `title` derivado | `videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- `initiateUpload` com `originalFilename: "trip.mp4"` persiste um `Video` com `title = "trip"` e `status = "draft"`
- `initiateUpload` com `fileSizeBytes` acima de 10GB é rejeitado antes de chamar `StorageService`
- `initiateUpload` chama `StorageService.createMultipartUpload` exatamente uma vez e persiste o `uploadId` retornado

---

### SI-03.5 — Endpoint POST /videos/:id/complete-upload

**Description:** Endpoint que finaliza o multipart upload e enfileira o job de processamento do vídeo (per `phase-03-videos/TD-02`, `phase-03-videos/TD-01`, `phase-03-videos/TD-07`).

**Route:** POST /videos/:id/complete-upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner only

**Technical actions:**

1. Criar `videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` com `parts: { partNumber, eTag }[]` (per `### API Contracts → POST /videos/:id/complete-upload`)
2. Criar `VideosService.completeUpload(videoId, ownerId, dto)` — valida ownership e `status === 'draft'` (senão `UPLOAD_ALREADY_COMPLETED`), chama `StorageService.completeMultipartUpload`, atualiza `status` para `processing` e publica o evento `video.process` na fila `video-processing` (per `### Events/Messages → video.process`)
3. Criar `VideosController.completeUpload` (`POST /videos/:id/complete-upload`) delegando para o service

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch logic — ownership, status guard, mock StorageService/queue (per Testing Requirements — Service com branching + DB) | `videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB contract — transição de `draft` para `processing` | `videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.2, SI-03.3

**Acceptance criteria:**

- `completeUpload` de um vídeo em `draft` chama `StorageService.completeMultipartUpload` e atualiza `status` para `processing`
- `completeUpload` publica exatamente um job `video.process` com `{ videoId, objectKey }` na fila `video-processing`
- `completeUpload` de um vídeo cujo `status` não é `draft` lança `UPLOAD_ALREADY_COMPLETED` sem chamar `StorageService`
- `completeUpload` de um vídeo que não pertence ao `ownerId` informado lança `VIDEO_NOT_FOUND`

---

### SI-03.6 — Endpoint POST /videos/:id/abort-upload

**Description:** Endpoint que aborta um multipart upload em andamento e remove o rascunho (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`).

**Route:** POST /videos/:id/abort-upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner only

**Technical actions:**

1. Criar `VideosService.abortUpload(videoId, ownerId)` — valida ownership e `status === 'draft'` (senão `UPLOAD_ALREADY_COMPLETED`), chama `StorageService.abortMultipartUpload` e remove o `Video`
2. Criar `VideosController.abortUpload` (`POST /videos/:id/abort-upload`) delegando para o service, retornando `204`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.abortUpload` | Unit: branch logic — ownership, status guard, mock StorageService (per Testing Requirements — Service com branching + DB) | `videos/videos.service.spec.ts` |
| `VideosService.abortUpload` | Integration: DB contract — remoção do `Video` em `draft` | `videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.3

**Acceptance criteria:**

- `abortUpload` de um vídeo em `draft` chama `StorageService.abortMultipartUpload` e remove o `Video` do banco
- `abortUpload` de um vídeo cujo `status` não é `draft` lança `UPLOAD_ALREADY_COMPLETED` sem remover o registro
- `abortUpload` de um vídeo que não pertence ao `ownerId` informado lança `VIDEO_NOT_FOUND`

---

### SI-03.7 — Endpoint GET /videos/:id

**Description:** Endpoint de consulta de status/metadata do vídeo, aplicando a Visibility rule (per `### API Contracts → GET /videos/:id`, `phase-03-videos/TD-06`).

**Route:** GET /videos/:id
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous quando `status = ready`; Owner nos demais status (ver Visibility rule)

**Technical actions:**

1. Criar `VideosService.findVisibleById(videoId, requesterId)` — retorna o `Video` quando `status === 'ready'` OU `requesterId` é o dono; caso contrário retorna `null` (mascarando a existência)
2. Criar `VideosController.findOne` (`GET /videos/:id`) — chama `findVisibleById`, mapeia `null` para `404 VIDEO_NOT_FOUND`, monta `thumbnailUrl` via `StorageService.getPresignedGetUrl` apenas quando `status === 'ready'`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findVisibleById` | Unit: branch logic — status × ownership matrix (per Testing Requirements — Service com branching + DB) | `videos/videos.service.spec.ts` |
| `VideosService.findVisibleById` | Integration: DB contract — mesma matriz contra o banco real | `videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- `findVisibleById` de um vídeo `ready` retorna o vídeo independentemente do `requesterId`
- `findVisibleById` de um vídeo em `draft`/`processing`/`failed` retorna o vídeo apenas quando `requesterId` é o dono
- `findVisibleById` de um vídeo em `draft`/`processing`/`failed` retorna `null` para `requesterId` diferente do dono ou anônimo
- `thumbnailUrl` só é preenchido na resposta quando `status === 'ready'`

---

### SI-03.8 — Worker: entrypoint dedicado

**Description:** Criar o entrypoint de worker dedicado que compartilha o código de domínio da API, materializando o container "Video Worker" da arquitetura (per `phase-03-videos/TD-04`).

**Technical actions:**

1. Criar `src/worker.ts` — bootstrap standalone (`NestFactory.createApplicationContext`) carregando `WorkerModule`
2. Criar `WorkerModule` importando `ConfigModule`, `TypeOrmModule` e `BullModule` (reaproveitando `queue.config.ts`/`storage.config.ts` já existentes)
3. Adicionar o serviço `video-worker` ao `docker-compose.yml` com `command: node dist/worker.js`, compartilhando a mesma imagem da API

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (per Testing Requirements — Module com configured imports) | `worker/worker.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2, SI-03.3

**Acceptance criteria:**

- `docker compose ps` mostra o serviço `video-worker` com status `running`, em container separado da API
- `WorkerModule` compila com `TypeOrmModule` e `BullModule` configurados
- O worker compartilha as entidades e configs (`ConfigType`) já usados pela API, sem duplicação de código

---

### SI-03.9 — Extração de metadata e thumbnail via FFmpeg

**Description:** Wrapper fino sobre FFmpeg (`ffprobe` + `ffmpeg`) via `child_process` para extrair duração/metadados e gerar o thumbnail (per `phase-03-videos/TD-05`).

**Technical actions:**

1. Criar `worker/ffmpeg.service.ts` — `FfmpegService.probeDuration(filePath): Promise<number>` executando `ffprobe` via `child_process` (per `phase-03-videos/TD-05`)
2. Criar `FfmpegService.extractThumbnail(filePath, outputPath): Promise<void>` executando `ffmpeg` via `child_process` para extrair um frame (per `phase-03-videos/TD-05`)
3. Registrar `FfmpegService` no `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration: real capture service / local adapter — arquivo de vídeo de teste real (per Testing Requirements — Service com side-effect dep) | `worker/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `probeDuration` de um arquivo de vídeo de teste retorna a duração em segundos com precisão de 1s
- `extractThumbnail` de um arquivo de vídeo de teste gera um arquivo de imagem no `outputPath`
- Um arquivo corrompido/inválido faz `probeDuration` e `extractThumbnail` rejeitarem a Promise, sem travar o processo

---

### SI-03.10 — Worker: processor da fila video-processing

**Description:** Consumer BullMQ que orquestra download do original, extração via FFmpeg, upload do thumbnail e atualização do status do vídeo, com retry/backoff (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`).

**Technical actions:**

1. Criar `worker/video-processing.processor.ts` — `@Processor('video-processing')` com `@Process()` recebendo `{ videoId, objectKey }` (per `### Events/Messages → video.process`)
2. Implementar o fluxo: baixar o objeto original via `StorageService`, chamar `FfmpegService.probeDuration` + `extractThumbnail`, subir o thumbnail via `StorageService`, atualizar `Video` para `status = 'ready'` com `durationSeconds`/`thumbnailKey` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
3. Configurar opções de retry/backoff do job (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`) e, ao esgotar as tentativas, atualizar `Video` para `status = 'failed'` com `failureReason`
4. Registrar o processor no `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: real lib com config de teste — BullMQ test queue (per Testing Requirements — Service com configured lib) | `worker/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration: DB contract — transições `processing → ready` e `processing → failed` | `worker/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.8, SI-03.9, SI-03.2, SI-03.3, SI-03.1

**Acceptance criteria:**

- Um job `video.process` bem-sucedido atualiza o `Video` para `status = 'ready'` com `durationSeconds` e `thumbnailKey` preenchidos
- Um job cuja extração FFmpeg falha é reprocessado conforme a política de retry/backoff configurada, sem marcar `failed` na primeira falha
- Um job que esgota as tentativas de retry atualiza o `Video` para `status = 'failed'` com `failureReason` preenchido

---

### SI-03.11 — Endpoint GET /videos/:id/stream

**Description:** Endpoint de streaming via redirecionamento para presigned GET, respeitando a Visibility rule (per `phase-03-videos/TD-06`).

**Route:** GET /videos/:id/stream
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous quando `status = ready`; Owner (com `409 VIDEO_NOT_READY`) nos demais status

**Technical actions:**

1. Criar `VideosService.getStreamUrl(videoId, requesterId)` — reaplica `findVisibleById` (SI-03.7); quando visível e `status === 'ready'`, retorna `StorageService.getPresignedGetUrl(objectKey)`; quando visível e não `ready`, sinaliza `VIDEO_NOT_READY`; quando não visível, sinaliza "not found"
2. Criar `VideosController.stream` (`GET /videos/:id/stream`) — mapeia o resultado para `302` com header `Location`, ou para os erros correspondentes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: branch logic — ready × not-ready × not-visible (per Testing Requirements — Service com branching + DB) | `videos/videos.service.spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- `getStreamUrl` de um vídeo `ready` retorna uma presigned GET URL, para qualquer `requesterId` (incluindo anônimo)
- `getStreamUrl` do dono para um vídeo não `ready` sinaliza `VIDEO_NOT_READY`
- `getStreamUrl` de um não-dono para um vídeo não `ready` sinaliza "not found" (mascarando a existência)

---

### SI-03.12 — Endpoint GET /videos/:id/download

**Description:** Endpoint de download via redirecionamento para presigned GET com `Content-Disposition: attachment`, respeitando a Visibility rule (per `phase-03-videos/TD-06`).

**Route:** GET /videos/:id/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Anonymous quando `status = ready`; Owner (com `409 VIDEO_NOT_READY`) nos demais status

**Technical actions:**

1. Estender `StorageService.getPresignedGetUrl` com um parâmetro opcional de `responseContentDisposition` (per `### API Contracts → GET /videos/:id/download`)
2. Criar `VideosService.getDownloadUrl(videoId, requesterId)` — reaplica a mesma lógica de visibilidade de `getStreamUrl` (SI-03.11), retornando a presigned GET URL com `Content-Disposition: attachment`
3. Criar `VideosController.download` (`GET /videos/:id/download`) — mapeia o resultado para `302` com header `Location`, ou para os erros correspondentes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: branch logic — ready × not-ready × not-visible (per Testing Requirements — Service com branching + DB) | `videos/videos.service.spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- `getDownloadUrl` de um vídeo `ready` retorna uma presigned GET URL com `Content-Disposition: attachment`, para qualquer `requesterId`
- `getDownloadUrl` do dono para um vídeo não `ready` sinaliza `VIDEO_NOT_READY`
- `getDownloadUrl` de um não-dono para um vídeo não `ready` sinaliza "not found" (mascarando a existência)

---

### SI-03.13 — Enriquecer spec OpenAPI dos endpoints de vídeo

**Description:** Materializar `openapi-docs-nestjs/TD-01` para os 6 endpoints desta fase — a inferência via CLI plugin cobre apenas os schemas de DTOs; operações, respostas por status code e contratos de erro exigem decoradores explícitos, seguindo o mesmo padrão já aplicado aos controllers de auth/users em `task-openapi-docs-nestjs/SI-5`.

**Technical actions:**

1. Anotar `VideosController` com `@ApiTags('videos')` no nível do controller e, por endpoint (`POST /videos`, `POST /videos/:id/complete-upload`, `POST /videos/:id/abort-upload`, `GET /videos/:id`, `GET /videos/:id/stream`, `GET /videos/:id/download`): `@ApiOperation({ summary, description })`, `@ApiBody({ type: <Dto> })` nos endpoints com corpo, `@ApiParam('id')` nos endpoints com path param (per `## Inherited Decisions Detail → openapi-docs-nestjs/TD-01`)
2. Adicionar `@ApiResponse` por status code documentado em `### API Contracts` de cada endpoint (sucesso: 201/200/204/302; erros: 400/404/409/413/415/502 conforme `### Error Catalog`), referenciando o schema compartilhado `ApiErrorEnvelope` (`nestjs-project/src/common/openapi/api-error-envelope.dto.ts`, já criado por `task-openapi-docs-nestjs/SI-5`) via `{ schema: { $ref: getSchemaPath(ApiErrorEnvelope) } }` — sem recriar o schema
3. Para os endpoints com `Authorization: Authenticated | Owner` (`POST /videos`, `.../complete-upload`, `.../abort-upload`), adicionar `@ApiBearerAuth('access-token')` (security scheme já registrado); os endpoints com Visibility rule (`GET /videos/:id`, `/stream`, `/download`) não recebem o decorator — são públicos quando `status = ready`
4. Re-executar `npm run openapi:export` e revisar o diff de `nestjs-project/openapi.json` antes de versionar — confirmar `summary`, `responses` por status code e referências a `#/components/schemas/ApiErrorEnvelope` nos 6 paths novos

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` (paths de vídeo) | Integration: extensão de `openapi-export.integration-spec.ts` (per `task-openapi-docs-nestjs/SI-5`) afirmando `summary`, `responses` por status code, `$ref` para `ApiErrorEnvelope` nos erros e `security` nos endpoints authenticated/owner | `src/openapi-export.integration-spec.ts` (extensão) |

**Dependencies:** SI-03.4, SI-03.5, SI-03.6, SI-03.7, SI-03.11, SI-03.12 _(anota os 6 controllers já implementados; não altera comportamento)_

**Acceptance criteria:**

- `npm run openapi:export` regera `nestjs-project/openapi.json` com os 6 paths de vídeo, cada um com `summary` não vazio e ≥1 `responses` de sucesso + ≥1 de erro
- Os endpoints `POST /videos`, `.../complete-upload` e `.../abort-upload` têm `security: [{ "access-token": [] }]` no spec exportado
- Os endpoints `GET /videos/:id`, `/stream` e `/download` não têm `security` obrigatório no spec (per Visibility rule)
- `docker compose exec nestjs-api npm run test -- openapi-export.integration-spec` passa com as novas asserções

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channelId | uuid | FK → Channel.id, not null |
| title | varchar(255) | not null |
| originalFilename | varchar(255) | not null |
| status | enum (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` |
| objectKey | varchar(1024) | unique, not null |
| uploadId | varchar(512) | nullable — S3 multipart upload id, cleared after completion or abort |
| thumbnailKey | varchar(1024) | nullable |
| durationSeconds | integer | nullable |
| sizeBytes | bigint | nullable |
| mimeType | varchar(255) | nullable |
| failureReason | text | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on write |

**Relations:** `Channel` has many `Video` (one-to-many)
**Indexes:** unique on `objectKey`; index on `channelId`; index on `status`
**Derivation:** `title` is auto-populated from `originalFilename` at creation (extension stripped, e.g. `trip.mp4` → `trip`) — this phase exposes no field or endpoint to set/edit it; title editing belongs to Phase 04 per `## Scope → Out of scope`.
**Key strategy:** `objectKey` follows `{channelId}/{videoId}/original.<ext>` in bucket `videos`; `thumbnailKey` follows `{channelId}/{videoId}/thumbnail.jpg` in bucket `thumbnails` (per `phase-03-videos/TD-03`).

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- originalFilename: string, required — no `title` field: the draft's title is auto-derived from this value (see Data Model → Video → Derivation), not user-supplied in this phase
- fileSizeBytes: number, required — must not exceed 10GB
- mimeType: string, required — must be an accepted video MIME type

**Response 201:**
- id: string (uuid)
- title: string — the auto-derived title, returned so the client can display it immediately without a follow-up `GET`
- uploadId: string
- objectKey: string
- partSizeBytes: number
- parts: array of { partNumber: number, uploadUrl: string }

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 413 FILE_TOO_LARGE: when fileSizeBytes exceeds the 10GB limit
- 415 UNSUPPORTED_MEDIA_TYPE: when mimeType is not an accepted video format

---

#### POST /videos/:id/complete-upload (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of { partNumber: number, eTag: string }, required

**Response 200:**
- id: string (uuid)
- status: string (`processing`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match a video owned by the authenticated user
- 409 UPLOAD_ALREADY_COMPLETED: when the video's status is no longer `draft`
- 400 validation error: when `parts` is missing or malformed
- 502 UPLOAD_COMPLETION_FAILED: when object storage rejects the multipart completion (e.g. ETag mismatch)

---

#### POST /videos/:id/abort-upload (SI-03.6)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match a video owned by the authenticated user
- 409 UPLOAD_ALREADY_COMPLETED: when the video's status is no longer `draft`

---

#### GET /videos/:id (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token} — optional; only consulted to resolve ownership when the video's status is not `ready` (see Visibility rule below)

**Response 200:**
- id: string (uuid)
- title: string
- status: string (`draft` | `processing` | `ready` | `failed`)
- durationSeconds: number | null
- thumbnailUrl: string | null — presigned GET URL, populated only when status is `ready`
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `id` does not exist, OR exists but is not `ready` and the requester is not its owner (existence is masked in the latter case — see Visibility rule)

**Visibility rule (applies identically to this endpoint, `/stream`, and `/download`):** when `status == ready`, the resource is anonymous-readable (per the platform's "anonymous can watch freely" policy and `phase-03-videos/TD-06`). When `status != ready` (`draft` | `processing` | `failed`), only the owner may read it — every other requester (anonymous or authenticated non-owner) receives `404 VIDEO_NOT_FOUND`, never a partial/reduced payload, so a non-owner cannot learn that an in-progress upload exists.

---

#### GET /videos/:id/stream (SI-03.11)

**Request headers:**
- Authorization: Bearer {access_token} — optional; only consulted to resolve ownership when the video's status is not `ready`

**Response 302:** redirect — `Location` header set to a time-limited presigned GET URL against object storage, supporting `Range` requests natively.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `id` does not exist, OR exists but is not `ready` and the requester is not its owner (per the Visibility rule above)
- 409 VIDEO_NOT_READY: video exists, requester is its owner, but status is not `ready` yet

---

#### GET /videos/:id/download (SI-03.12)

**Request headers:**
- Authorization: Bearer {access_token} — optional; only consulted to resolve ownership when the video's status is not `ready`

**Response 302:** redirect — `Location` header set to a time-limited presigned GET URL against object storage with a `Content-Disposition: attachment` override, forcing a full download instead of inline playback.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `id` does not exist, OR exists but is not `ready` and the requester is not its owner (per the Visibility rule above)
- 409 VIDEO_NOT_READY: video exists, requester is its owner, but status is not `ready` yet

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:id/complete-upload | ✗ | ✗ | ✓ |
| POST /videos/:id/abort-upload | ✗ | ✗ | ✓ |
| GET /videos/:id | ✓* | ✓* | ✓ |
| GET /videos/:id/stream | ✓* | ✓* | ✓ |
| GET /videos/:id/download | ✓* | ✓* | ✓ |

`✓*` — conditional on `status == ready` (see the Visibility rule under each endpoint in API Contracts). The Owner column is unconditional: the owner can always read/stream/download their own video regardless of status (subject to `409 VIDEO_NOT_READY` on `/stream` and `/download` while not yet `ready`). Anonymous/non-owner requests against a non-`ready` video receive `404 VIDEO_NOT_FOUND`, not a partial response.

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| FILE_TOO_LARGE | 413 | `fileSizeBytes` informado excede o limite de 10GB |
| UNSUPPORTED_MEDIA_TYPE | 415 | `mimeType` informado não é um formato de vídeo aceito |
| VIDEO_NOT_FOUND | 404 | `id` não existe, OU existe mas não está `ready` e quem pediu não é o dono (existência mascarada nesse segundo caso — Visibility rule) |
| UPLOAD_ALREADY_COMPLETED | 409 | Tentativa de completar ou abortar um upload cujo vídeo não está mais em `draft` |
| UPLOAD_COMPLETION_FAILED | 502 | Object storage rejeitou a finalização do multipart upload (ex.: ETag inválido) |
| VIDEO_NOT_READY | 409 | Dono solicita streaming/download do próprio vídeo antes do status virar `ready` |

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid", "objectKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
**Consumer:** `VideoProcessingWorker` (per `phase-03-videos/TD-04`)
**Trigger:** cliente conclui o multipart upload via `POST /videos/:id/complete-upload` (SI-03.5)
**Delivery semantics:** at-least-once, com retry e backoff configurados no job (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`) — o status do vídeo só transiciona para `failed` após as tentativas de retry se esgotarem

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 — Entidade Video e migration (root)
├── SI-03.4 — Endpoint POST /videos (depends on SI-03.1 + SI-03.3 — entidade e storage client devem existir)
│   ├── SI-03.5 — Endpoint POST /videos/:id/complete-upload (depends on SI-03.4 + SI-03.2 + SI-03.3 — draft/uploadId, fila e storage)
│   └── SI-03.6 — Endpoint POST /videos/:id/abort-upload (depends on SI-03.4 + SI-03.3 — draft/uploadId e storage)
├── SI-03.7 — Endpoint GET /videos/:id (depends on SI-03.1 + SI-03.3 — entidade e presigned GET do thumbnail)
├── SI-03.8 — Worker: entrypoint dedicado (depends on SI-03.1 + SI-03.2 + SI-03.3 — entidade, fila e storage.config.ts reaproveitado)
│   ├── SI-03.9 — Extração de metadata e thumbnail via FFmpeg (depends on SI-03.8 — contexto do worker)
│   └── SI-03.10 — Worker: processor da fila video-processing (depends on SI-03.8 + SI-03.9 + SI-03.2 + SI-03.3 + SI-03.1)
├── SI-03.11 — Endpoint GET /videos/:id/stream (depends on SI-03.1 + SI-03.3)
└── SI-03.12 — Endpoint GET /videos/:id/download (depends on SI-03.1 + SI-03.3)

SI-03.13 — Enriquecer spec OpenAPI dos endpoints de vídeo (depends on SI-03.4 + SI-03.5 + SI-03.6 + SI-03.7 + SI-03.11 + SI-03.12 — anota os 6 controllers já implementados)

SI-03.2 — Infra: fila de processamento (root, independent)
SI-03.3 — Infra: cliente de object storage (root, independent)
```

---

## Deliverables

- [ ] SI-03.1 — Entidade Video e migration
- [ ] SI-03.2 — Infra: fila de processamento (BullMQ + Redis)
- [ ] SI-03.3 — Infra: cliente de object storage (AWS SDK v3)
- [ ] SI-03.4 — Endpoint POST /videos (iniciar upload)
- [ ] SI-03.5 — Endpoint POST /videos/:id/complete-upload
- [ ] SI-03.6 — Endpoint POST /videos/:id/abort-upload
- [ ] SI-03.7 — Endpoint GET /videos/:id
- [ ] SI-03.8 — Worker: entrypoint dedicado
- [ ] SI-03.9 — Extração de metadata e thumbnail via FFmpeg
- [ ] SI-03.10 — Worker: processor da fila video-processing
- [ ] SI-03.11 — Endpoint GET /videos/:id/stream
- [ ] SI-03.12 — Endpoint GET /videos/:id/download
- [ ] SI-03.13 — Enriquecer spec OpenAPI dos endpoints de vídeo

**Full test suites:**

- [ ] Testes unitários e de integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
- [ ] Build compila com sucesso, incluindo `dist/worker.js` (`docker compose exec nestjs-api npm run build`)
