---
libs:
  "bullmq":
    version: "^6.1.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-08-19T20:20:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-08-19T20:20:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1113.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-19T20:20:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1113.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-19T20:20:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-19T20:18:39-03:00"
---

### bullmq

Used by TD-01 (Message Queue Technology). Core primitives needed for the video-processing queue:

- `new Queue(name, { connection })` — producer side, created in the API process to enqueue a processing job once a multipart upload completes (TD-02) and the video row flips from `draft` to `processing` (TD-07).
- `new Worker(name, processor, { connection })` — consumer side, created in the dedicated worker entrypoint (TD-04).
- Retry/backoff (TD-07's "Enum column + BullMQ automatic retry/backoff" decision) is configured per-job or as a queue default:
  ```typescript
  await queue.add('process-video', { videoId }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
  ```
  or as a `Queue`-level default via `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }`. The video's `status` flips to `error` only after all automatic attempts are exhausted; to `ready` as soon as one attempt succeeds — exactly the semantics TD-07 decided.
- Connection: `new IORedis({ maxRetriesPerRequest: null })` is the documented connection shape for a `Worker`; the same connection object (or equivalent config) is shared/reused between `Queue` and `Worker` instances per service.

### @nestjs/bullmq

Used by TD-01 (NestJS-native wrapper around `bullmq`) and TD-04 (worker execution model — the worker entrypoint hosts the `@Processor`/`WorkerHost` consumer). Canonical wiring for this phase:

- **Module registration** (in the API's queue-producing module):
  ```typescript
  import { BullModule } from '@nestjs/bullmq';

  @Module({
    imports: [BullModule.registerQueue({ name: 'video-processing' })],
  })
  export class VideosModule {}
  ```
- **Injecting the queue** to enqueue a job from the upload-confirmation service:
  ```typescript
  import { InjectQueue } from '@nestjs/bullmq';
  import { Queue } from 'bullmq';

  @Injectable()
  export class VideosService {
    constructor(@InjectQueue('video-processing') private queue: Queue) {}
  }
  ```
- **Worker-side consumer** (in the dedicated worker entrypoint, per TD-04):
  ```typescript
  import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
  import { Job } from 'bullmq';

  @Processor('video-processing')
  export class VideoProcessor extends WorkerHost {
    async process(job: Job<{ videoId: string }>): Promise<any> {
      // TD-05: ffprobe/ffmpeg via child_process; on success set status=ready, on
      // exhausted retries BullMQ marks the job failed and TD-07's error path applies.
    }

    @OnWorkerEvent('failed')
    onFailed(job: Job) {
      // update video status to 'error' once retries are exhausted
    }
  }
  ```
- Both the API module and the worker entrypoint must register the same queue name against the same Redis connection (shared `registerAs('queue', ...)` config factory, per the inherited config convention from phase 01).

### @aws-sdk/client-s3

Used by TD-03 (Object Storage Client & Bucket/Key Strategy) as the low-level client for every MinIO interaction — multipart upload orchestration (TD-02) and object retrieval (TD-06). Configured with a custom endpoint + `forcePathStyle: true` so the same client code works against MinIO now and real AWS S3 later (per TD-03's rationale):

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: storageConfig.endpoint, // MinIO service URL
  forcePathStyle: true,
  region: storageConfig.region,
  credentials: { accessKeyId: storageConfig.accessKey, secretAccessKey: storageConfig.secretKey },
});
```

Multipart upload flow (TD-02's "presigned multipart upload direct to object storage"), driven from the API — each part is presigned individually via `@aws-sdk/s3-request-presigner`, the client itself only orchestrates the multipart lifecycle:

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));
// ... per part: presign UploadPartCommand (see @aws-sdk/s3-request-presigner below) ...
await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: completedParts } }));
// on failure/timeout:
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

Per the SDK's own docs (`AbortMultipartUploadCommand`): in-progress `UploadPart` calls might still succeed after an abort, so abort may need to be called more than once, and `ListParts` should be checked to confirm no parts remain — relevant to TD-07's failure-handling path when a video upload is abandoned mid-flight.

### @aws-sdk/s3-request-presigner

Used by TD-03 (presigning surface for both TD-02's upload and TD-06's streaming/download). Single function, `getSignedUrl(client, command, options)`, wraps any S3 command:

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// TD-02 — per-part presigned upload URL:
const uploadUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// TD-06 — presigned GET for streaming/download:
const getUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: 3600 },
);
```

Load-bearing detail for TD-06 (streaming via HTTP `Range` requests): the presigner does **not** strip the `Range` header — only SDK-internal headers (`amz-sdk-invocation-id`, `amz-sdk-request`, `x-amz-user-agent`) are removed before signing. If `Range` is set on the `GetObjectCommand` input, it is serialized into the request, signed, and included in `X-Amz-SignedHeaders` — so a presigned URL genuinely supports partial-content playback without any custom backend relay code, exactly as TD-06 assumes. `expiresIn` defaults to 900 seconds if omitted.
