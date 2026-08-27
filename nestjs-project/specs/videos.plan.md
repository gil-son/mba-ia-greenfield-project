---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4, SI-03.5, SI-03.6, SI-03.7, SI-03.11, SI-03.12
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# Videos Endpoints Test Plan

## Application Overview

Endpoints REST do recurso `Video`: iniciar/concluir/abortar o multipart upload, consultar status/metadata e servir streaming/download via redirect para presigned URL de object storage. Todos aplicam a mesma Visibility rule (anônimo-legível apenas quando `status = ready`; caso contrário só o dono, com existência mascarada para os demais) e compartilham o mesmo arquivo de teste E2E por serem parte do mesmo controller/resource, seguindo a convenção do projeto (`auth.e2e-spec.ts` agrupa `/auth/*` do mesmo jeito).

## Test Scenarios

### 1. POST /videos (SI-03.4)

**Setup:** `beforeEach` truncate test DB (`cleanAllTables`); bootstrap `AppModule` com pipes/filters globais reproduzidos manualmente (per `main.ts`); fixture de owner autenticado via `registerConfirmAndLogin` (herdado da Fase 02) com canal já existente.

#### 1.1. derives-title-from-filename

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `POST /videos` com `{ originalFilename: "trip.mp4", fileSizeBytes: 1000000, mimeType: "video/mp4" }`
    - expect: 201 com body contendo `title: "trip"`
  2. Owner faz `GET /videos/:id` usando o `id` retornado no passo 1
    - expect: 200 com `status: "draft"`

#### 1.2. rejects-file-size-over-10gb

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `POST /videos` com `fileSizeBytes` = 10 * 1024³ + 1 (acima do limite de 10GB)
    - expect: 413 com `errorCode: "FILE_TOO_LARGE"`

#### 1.3. initiates-real-multipart-upload

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `POST /videos` com payload válido
    - expect: 201 com `uploadId` não vazio, `objectKey` no formato `{channelId}/{videoId}/original.<ext>`, e `parts` com ao menos um item `{ partNumber, uploadUrl }` sendo `uploadUrl` uma presigned URL válida contra o MinIO local

---

### 2. POST /videos/:id/complete-upload (SI-03.5)

**Setup:** reaproveita fixture de owner do Grupo 1; cria um `Video` em `draft` via `POST /videos` e realiza o upload real das partes contra o MinIO local para obter `eTag`s válidos.

#### 2.1. completes-upload-and-transitions-to-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `POST /videos/:id/complete-upload` com `{ parts: [{ partNumber: 1, eTag: "<etag-real-do-upload>" }] }` para o vídeo em `draft`
    - expect: 200 com body `{ id, status: "processing" }`

#### 2.2. publishes-exactly-one-video-process-job

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado completa o upload de um vídeo em `draft`
    - expect: exatamente um job `video.process` enfileirado na fila `video-processing` com payload `{ videoId, objectKey }` (verificado via inspeção da fila de teste do BullMQ)

#### 2.3. rejects-non-draft-video

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado tenta `POST /videos/:id/complete-upload` de um vídeo que já está em `processing` (upload completado previamente)
    - expect: 409 com `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 2.4. masks-video-not-owned

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Usuário autenticado diferente do dono tenta `POST /videos/:id/complete-upload` de um vídeo em `draft` de outro canal
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"`

---

### 3. POST /videos/:id/abort-upload (SI-03.6)

**Setup:** reaproveita fixture de owner do Grupo 1; cria um `Video` em `draft` via `POST /videos`.

#### 3.1. aborts-and-removes-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `POST /videos/:id/abort-upload` de um vídeo em `draft`
    - expect: 204
  2. Owner faz `GET /videos/:id` do mesmo `id`
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"` (registro removido)

#### 3.2. rejects-non-draft-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado tenta `POST /videos/:id/abort-upload` de um vídeo já em `processing`
    - expect: 409 com `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 3.3. masks-video-not-owned

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Usuário autenticado diferente do dono tenta `POST /videos/:id/abort-upload` de um vídeo em `draft` de outro canal
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"`

---

### 4. GET /videos/:id (SI-03.7)

**Setup:** reaproveita fixture de owner do Grupo 1; cria vídeos nos status `draft`, `processing`, `failed` e `ready` diretamente via repositório de teste (sem passar pelo fluxo completo de upload) para exercitar a Visibility rule em cada status.

#### 4.1. ready-video-visible-to-anyone

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Requisição anônima (sem `Authorization`) faz `GET /videos/:id` de um vídeo em `ready`
    - expect: 200 com body completo (`id`, `title`, `status: "ready"`, `durationSeconds`, `thumbnailUrl`, `createdAt`)

#### 4.2. non-ready-video-visible-to-owner

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `GET /videos/:id` de um vídeo próprio em `draft`
    - expect: 200 com `status: "draft"`

#### 4.3. non-ready-video-masked-for-others

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Requisição anônima faz `GET /videos/:id` de um vídeo em `draft` de outro canal
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"`
  2. Usuário autenticado (não dono) faz `GET /videos/:id` do mesmo vídeo em `draft`
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"`

#### 4.4. thumbnail-url-only-when-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `GET /videos/:id` de um vídeo próprio em `processing`
    - expect: 200 com `thumbnailUrl: null`
  2. Qualquer requisitante faz `GET /videos/:id` do mesmo vídeo após transicionar para `ready`
    - expect: 200 com `thumbnailUrl` não nulo (presigned URL)

---

### 5. GET /videos/:id/stream (SI-03.11)

**Setup:** reaproveita as fixtures de vídeo por status do Grupo 4.

#### 5.1. ready-video-streams-for-anyone

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Requisição anônima faz `GET /videos/:id/stream` de um vídeo em `ready`
    - expect: 302 com header `Location` contendo uma presigned GET URL válida contra o MinIO local

#### 5.2. owner-non-ready-gets-not-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `GET /videos/:id/stream` de um vídeo próprio em `processing`
    - expect: 409 com `errorCode: "VIDEO_NOT_READY"`

#### 5.3. non-owner-non-ready-masked

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Requisição anônima (ou de usuário autenticado não-dono) faz `GET /videos/:id/stream` de um vídeo em `processing` de outro canal
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"`

---

### 6. GET /videos/:id/download (SI-03.12)

**Setup:** reaproveita as fixtures de vídeo por status do Grupo 4.

#### 6.1. ready-video-downloads-for-anyone

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Requisição anônima faz `GET /videos/:id/download` de um vídeo em `ready`
    - expect: 302 com header `Location` contendo uma presigned GET URL com `Content-Disposition: attachment`

#### 6.2. owner-non-ready-gets-not-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Owner autenticado faz `GET /videos/:id/download` de um vídeo próprio em `processing`
    - expect: 409 com `errorCode: "VIDEO_NOT_READY"`

#### 6.3. non-owner-non-ready-masked

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-24T10:29:14Z

**Steps:**
  1. Requisição anônima (ou de usuário autenticado não-dono) faz `GET /videos/:id/download` de um vídeo em `processing` de outro canal
    - expect: 404 com `errorCode: "VIDEO_NOT_FOUND"`
