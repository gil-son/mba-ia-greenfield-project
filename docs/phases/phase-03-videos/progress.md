# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/13 completed

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
- **Status:** completed
- **Tests:** 8 passing (4 unit + 1 integration + 3 e2e)
- **Observations:**
  - **Bug pré-existente corrigido (confirmado com o usuário antes de agir):** `videos/videos.module.spec.ts` (da SI-03.3) estava falhando antes de eu tocar em qualquer código da SI-03.4 — o teste de compilação só carregava `queueConfig` no `ConfigModule.forRoot`, mas o `StorageModule` (importado pela `VideosModule` desde a SI-03.3) precisa de `storageConfig.KEY`. Corrigido adicionando `storageConfig` ao `load: [...]` do teste.
  - Estendida `StorageService` com um novo método `getPresignedUploadPartUrls` (aditivo, não altera a assinatura de `createMultipartUpload`) para cumprir o contrato de resposta de `POST /videos` (`partSizeBytes` + `parts[]`) — não estava listado nas Technical actions da SI-03.4, mas é exigido pelo `### API Contracts` da própria SI e pelo Test Spec E2E (parts com presigned URL válida contra o MinIO).
  - Adicionado `ChannelsService.findByUserId` (aditivo) para resolver o `channelId` do usuário autenticado — não existia método equivalente antes.
  - `MULTIPART_PART_SIZE_BYTES` fixado em 100MB (`videos/videos.constants.ts`) — não há TD/spec explicitando o tamanho de parte; escolhido por ficar dentro dos limites do S3/MinIO (mín. 5MB, máx. 10.000 partes) para o teto de 10GB.
  - `test/videos.e2e-spec.ts` (Grupo 1, cenário `derives-title-from-filename`): o passo 2 do spec original faz `GET /videos/:id` para verificar o `status`, mas essa rota é da SI-03.7 (fora do escopo desta rodada). Adaptado para ler o `status` diretamente do repositório `Video` no teste; mesma adaptação será necessária no cenário de abort da SI-03.6.
  - **Achado fora de escopo, não corrigido:** `npm run lint` já falhava antes desta SI, com 145+ erros pré-existentes em arquivos já commitados das fases 01/02 (`test/auth.e2e-spec.ts`: 48 erros; `src/auth/auth.service.spec.ts` + `src/channels/channels.service.spec.ts`: 97 erros) — majoritariamente `@typescript-eslint/no-unsafe-*` sobre corpos de resposta `any` do supertest e sobre `jest.Mocked`. Não tentei corrigir esse débito pré-existente — está fora do escopo da Fase 03. Sinalizando para revisão no final da fase.
  - **Retrofit de lint nos arquivos novos (a pedido do usuário):** inicialmente espelhei o padrão de `auth.e2e-spec.ts`/`auth.service.spec.ts` (incluindo os mesmos padrões que disparam `no-unsafe-member-access`/`unbound-method`), mas a pedido do usuário retrofitei `videos.service.spec.ts` e `test/videos.e2e-spec.ts` para não disparar esses erros — mocks como `const` tipados (em vez de `jest.Mocked<...>` acessado por propriedade) e interfaces locais para os corpos de resposta do supertest (`res.body as CreateVideoResponse`, etc.), em vez de castings via `any`. `npx eslint` confirma zero erros nos arquivos novos da Fase 03 (só resta o débito pré-existente citado acima). Válido como padrão a seguir nas SIs 03.5/03.6 em diante.
  - Warning `pg` (`Calling client.query() when the client is already executing a query is deprecated...`) investigado a pedido do usuário: rastreado via `node --trace-deprecation` até a pilha `PostgresQueryRunner.loadTables → RdbmsSchemaBuilder.build → DataSource.synchronize → DataSource.initialize` — inteiramente interno ao TypeORM 0.3.28 (o próprio `loadTables()` roda múltiplas queries de metadata via `Promise.all` reaproveitando o mesmo client durante o `synchronize: true` de `createTestDataSource`). Confirmado sistêmico rodando `video.entity.integration-spec.ts` (não tocado nesta sessão) isoladamente — mesmo warning, mesma pilha. Não é uma chamada da aplicação sem `await`; não há correção a fazer.
  - **Segundo bug pré-existente encontrado durante essa investigação e corrigido (confirmado com o usuário):** `channels/entities/channel.entity.integration-spec.ts` falhava sozinho (5/5 testes) porque seu `ALL_ENTITIES` não incluía `Video`, mas `Channel` ganhou `@OneToMany(() => Video, ...)` na SI-03.1 — TypeORM não resolve a relação inversa sem `Video` no mesmo DataSource. Mesma classe de gap do `videos.module.spec.ts` corrigido antes. Corrigido adicionando `Video` a `ALL_ENTITIES`; os 5 testes voltam a passar.

### SI-03.5 — Endpoint POST /videos/:id/complete-upload
- **Status:** completed
- **Tests:** 17 passing (8 unit + 2 integration + 7 e2e)
- **Observations:**
  - `VideosService` ganhou `@InjectQueue('video-processing')` no construtor (necessário para publicar o job `video.process`) — como consequência, os testes unitário e de integração da SI-03.4 (`initiateUpload`) precisaram de um provider/módulo de fila adicionado ao respectivo `TestingModule` (mock `getQueueToken` no unit, `BullModule` real no integration), mesmo sem `initiateUpload` usar a fila. Ambos continuam passando.
  - Job `video.process` publicado com `attempts: 3` e `backoff: { type: 'exponential', delay: 1000 }` (per `phase-03-videos/TD-07` e `library-refs.md`), embora as ACs da SI não exijam esses parâmetros explicitamente.
  - Nome do job usado: `'video.process'` (mesmo nome do evento em `### Events/Messages`), em vez de um nome genérico como `'process-video'` do exemplo de `library-refs.md` — mantém rastreabilidade 1:1 entre o nome do job na fila e a seção de Events/Messages do plano.
  - Testes novos (unit, integration, e2e) escritos já com os padrões de lint limpos combinados na SI-03.4 (mocks `const` tipados, interfaces locais para corpos de resposta do supertest, `Queue<VideoProcessJobData>` tipado para evitar `no-unsafe-member-access` em `job.data`). `npx eslint` confirma zero erros nos arquivos novos/alterados desta SI.

### SI-03.6 — Endpoint POST /videos/:id/abort-upload
- **Status:** completed
- **Tests:** 24 passing (11 unit + 3 integration + 10 e2e)
- **Observations:**
  - Reaproveitados `findOwnedVideoOrThrow`/`assertDraft` (privados, criados na SI-03.5) para `abortUpload` — mesma checagem de ownership/status, sem duplicação.
  - `videoRepository.remove(video)` usado em vez de `delete({id})` — já temos a entidade carregada (para a checagem de ownership) e `remove` é a forma idiomática do TypeORM para isso; evita o problema de `delete({})` com critério vazio (não se aplica aqui, mas mantém o padrão idiomático).
  - `test/videos.e2e-spec.ts` (Grupo 3, cenário `aborts-and-removes-draft`): mesma adaptação da SI-03.4 — o passo 2 do spec original faz `GET /videos/:id` esperando 404; como a SI-03.7 ainda não existe nesta rodada, a remoção é verificada direto no repositório `Video` via `findOneBy` retornando `null`.
  - Todos os arquivos novos/alterados desta SI já seguem os padrões de lint limpos combinados (mocks `const` tipados, interfaces locais para supertest) — `npx eslint` e `npx tsc --noEmit` confirmam zero erros/warnings nos arquivos de vídeo.
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
