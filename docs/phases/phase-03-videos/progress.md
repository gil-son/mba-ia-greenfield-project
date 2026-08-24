# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/13 completed

### SI-03.1 — Entidade Video e migration
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - Adicionada a relação inversa `Channel.videos` (`@OneToMany`) em `channel.entity.ts` — não estava listada nas Technical actions da SI, mas é exigida pela convenção do projeto de relações bidirecionais (`nestjs-entities.md`) e pelo próprio Data Model ("Channel has many Video").
  - Migration gerada via `npm run migration:generate` (CLI) e formatada com Prettier para bater com o estilo das migrations existentes; aplicada ao banco de dev.
  - `cleanAllTables` (test helper) atualizado para truncar `videos` antes de `channels`/`users`.

### SI-03.2 — Infra: fila de processamento (BullMQ + Redis)
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `ioredis@^5` instalado como dependência direta — peer dependency exigido pelo `bullmq@^6.1.2` para carregar sua conexão Redis (não listado em `library-refs.md`/TD-01); sem ele o `BullModule.forRootAsync` falhava com `BullMQ could not load the optional 'ioredis' package`.
  - `BullModule.forRootAsync` registrado em `AppModule` (paralelo ao `TypeOrmModule.forRootAsync`) usando a chave `connection` (não `redis`) — forma correta para `@nestjs/bullmq` v11 (BullMQ nativo), confirmada via context7 contra a doc oficial do Nest.

### SI-03.3 — Infra: cliente de object storage (AWS SDK v3)
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - **Gap no plano, confirmado com o usuário antes de agir:** as Technical actions da SI não incluíam adicionar um serviço MinIO ao `compose.yaml` (diferente da SI-03.2, que listava o Redis explicitamente como action 1), mas o Tests row e as ACs da própria SI exigem um "real capture service — MinIO" para testar contra. Adicionado serviço `minio` ao `compose.yaml` (por analogia direta ao padrão do Redis na SI-03.2), com credenciais de dev. `StorageService.onModuleInit` garante a criação idempotente dos buckets `videos`/`thumbnails` no boot (sem precisar de um container `mc` de init separado).
  - `getPresignedGetUrl` implementado SEM o parâmetro `responseContentDisposition` — o próprio plano diz que a SI-03.12 (fora do escopo desta passada) "estende" esse método com esse parâmetro depois; adicioná-lo agora seria antecipar trabalho de uma SI futura.
  - `ioredis`/`bullmq` deixados intactos; instalados apenas `@aws-sdk/client-s3@^3.1113.0` e `@aws-sdk/s3-request-presigner@^3.1113.0` (versões da TD-03).

### SI-03.4 — Endpoint POST /videos (iniciar upload)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Endpoint POST /videos/:id/complete-upload
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Endpoint POST /videos/:id/abort-upload
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Endpoint GET /videos/:id
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Worker: entrypoint dedicado
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Extração de metadata e thumbnail via FFmpeg
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Worker: processor da fila video-processing
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/:id/stream
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.12 — Endpoint GET /videos/:id/download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.13 — Enriquecer spec OpenAPI dos endpoints de vídeo
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
