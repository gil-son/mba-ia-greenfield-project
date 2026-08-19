---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-16T18:30:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-19T20:18:39-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-16T18:30:32-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-16T18:30:32-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-16T18:30:32-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-16T18:30:32-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-19T20:25:50-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-16T18:30:32-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in `docs/project-plan.md` beyond the capability bullets above._ Per the phase-scope decisions doc: comments, likes, subscriptions, video-management screens (edit/delete), and channel pages belong to later phases and are not touched here.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — owns the entire Phase 03 surface: upload initiation, video draft persistence, queue producer, video worker (metadata/thumbnail processing), object storage integration, streaming/download endpoints.

**Deferred subprojects:** `next-frontend/` — the upload UI, progress indicator, and video player consuming the streaming/download URLs are out of scope for this phase (backend-only). Will be addressed when the frontend catches up to Phase 03+ in a future phase. The upload/streaming contracts decided here (TD-02, TD-06) become the constraints that phase's frontend TDs must consume.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior; depends on Fase 01).
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (next; depends on Fase 02, Fase 03).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A | — |
| phase-03-videos/TD-02 | phase | Backend | Video Upload Strategy for Files up to 10GB | decided | A | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Client & Bucket/Key Strategy | decided | B | — |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Execution Model | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | FFmpeg Integration for Metadata Extraction & Thumbnail Generation | decided | B | — |
| phase-03-videos/TD-06 | phase | Backend | Video Streaming & Download Delivery Strategy | decided | B | — |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle & Failure Handling | decided | B | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|------------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-03 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis (via `@nestjs/bullmq`) — it is the only option purpose-built for retryable, progress-tracked background jobs (fits TD-07's retry/backoff needs directly), has an official NestJS integration already compatible with the installed Nest 11, and materializes the architecture diagram's "Message Queue" container as a real, visible service — which the phase's own checklist treats as a deliverable ("Fila, worker ou storage não subindo de verdade no Compose" is listed as an automatic-fail condition). Redis is a lightweight, well-understood addition to local Docker Compose.

**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** Multipart presigned upload — it is the only option where a 10GB upload has zero throughput cost on the API process, matching the capability's explicit "sem impacto na performance" wording, and multipart is the mechanism that actually makes objects of that size possible against an S3-compatible API in the first place.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3 — TD-02's presigned multipart upload is the flow this decision must support cleanly, and it is a first-class, thoroughly documented capability of the AWS SDK, not of the MinIO-specific client. It also keeps the storage client itself S3-generic, aligned with the architecture diagram's own framing of the container as "Object Storage (S3/MinIO)" rather than MinIO-specific.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Dedicated worker entrypoint in the Compose stack — it is the only option that gives a genuinely separate container/process (as the phase requires) without introducing monorepo/workspace tooling the project has not adopted, while still sharing the domain code (entities, config, video services) that both the API and worker need — avoiding the duplication risk of Option B.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** FFmpeg via direct `child_process` (thin wrapper) — the npm registry confirms `fluent-ffmpeg` is deprecated and its own maintainers confirm breakage against recent FFmpeg versions, so that option is disqualified outright; no vetted successor exists, and the worker's actual FFmpeg usage (one `ffprobe` call, one `ffmpeg` frame-extraction call) is small enough that a thin, explicit wrapper avoids both the abandoned-dependency risk and any wrapper abstraction entirely.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Presigned GET (streaming/download via MinIO S3 compatibility) — it mirrors TD-02's upload decision (keep bytes off the API), gets correct Range-request/206 behavior for free from MinIO's S3 compatibility instead of hand-rolled partial-content code, and serves both streaming and download capabilities with the same mechanism.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Enum-based status lifecycle with retry — it costs nothing beyond configuring job options already available once TD-01 (BullMQ) is chosen, and it is the only option that distinguishes a truly-failed video from a merely-transient hiccup without adding the transition-matrix overhead a full state machine would require for a state space this small.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Custom session helper over `next/headers` cookies (not Auth.js) — the strict-BFF model already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and a ~50-LOC session helper is grep-friendly, debuggable, and test-friendly, avoiding Auth.js compatibility risk with Next.js 16 / React 19.

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** `iron-session` (encrypted, `httpOnly` cookie) — defense in depth on the cookie content, a single cookie to manage simplifies logout, and room to carry minimal user metadata (`userId`, `email`, `channelSlug`) lets RSC render authenticated chrome without a per-render `/auth/me` round-trip.

**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Server-side single-flight refresh helper — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Client-driven and pre-emptive-timer alternatives were rejected (don't replace the RSC-side need, or introduce failure modes across tabs/sleep-wake that outweigh the latency saving).

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** react-hook-form + Zod resolvers — decoupled from the Route-Handler-vs-Server-Action choice, aligned with shadcn's canonical form primitive already adopted (`radix-nova`), and consistent with the Zod-first pattern already used for env validation.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handlers as the single mutation surface — keeps every mutation visible under `app/api/**`, reuses the existing MSW+BFF test scaffold with zero invention, and sets a uniform precedent for Phases 03–07 instead of per-mutation idiom-picking.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** RSC reads the session cookie and hydrates a Client Provider — no first-render flicker, no round-trip, and no new BFF endpoint since the cookie remains the source of truth; `router.refresh()` after mid-session mutations is the only cost.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC owns the token, Client Component owns the input (shared pattern across confirmation and reset-password flows) — first-paint-correct with no skeleton/flicker, and a single integration pattern reused across both flows.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` (official, decorator-based, with CLI plugin `classValidatorShim: true`) — it is the only option that preserves the already-decided validation stack (`class-validator` in phase-02-auth/TD-06) without a re-platform; the CLI plugin reuses the existing `class-validator` decorators to infer schemas, keeping boilerplate low. Enrichment via explicit decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`) is part of this decision, not out-of-scope follow-up work.

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Both — runtime Swagger UI (`/api/docs`) and a static `openapi.json` artifact exported via script — the marginal cost over runtime-only is a ~15-line npm script, and the benefit is a stable, offline-consumable artifact for future frontend codegen without losing the interactive UI dev/QA use.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Swagger UI enabled only in dev/staging (disabled in prod via env flag) — aligns with the defensive posture already established in phase 02 (rate limiting, refresh rotation) without compromising legitimate consumers, since the committed `openapi.json` (TD-02) still serves as a consultable spec outside the UI.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

_(from the `testing-guide-nestjs-project` Skill — Feature Implementation Checklist)_

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (e.g. BullMQ producer) | Unit: real lib with test config |
| Service with side-effect dep (e.g. object storage) | Integration: real capture service / local adapter (MinIO) |
| Module with configured imports (e.g. `BullModule.registerQueue()`) | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |

`next-frontend/` is deferred for this phase (see Scope) — no testing requirements to record here; will be defined when the frontend catches up to this phase's contracts.
