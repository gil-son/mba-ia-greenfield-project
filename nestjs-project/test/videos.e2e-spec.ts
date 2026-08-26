import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { ChannelsService } from '../src/channels/channels.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

interface ErrorBody {
  error: string;
}

interface CreateVideoResponse {
  id: string;
  title: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
  parts: { partNumber: number; uploadUrl: string }[];
}

interface CompleteUploadResponse {
  id: string;
  status: string;
}

interface VideoDetailsResponse {
  id: string;
  title: string;
  status: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  createdAt: string;
}

interface AuthServiceInternal {
  mailService: MailService;
}

interface VideoProcessJobData {
  videoId: string;
  objectKey: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let videoQueue: Queue<VideoProcessJobData>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoQueue = moduleFixture.get<Queue<VideoProcessJobData>>(
      getQueueToken('video-processing'),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as unknown as AuthServiceInternal)
      .mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string) => {
          capturedToken = token;
          return Promise.resolve();
        },
      );
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<AuthTokens> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body as AuthTokens;
  }

  async function createDraftVideoWithUploadedPart(
    email: string,
  ): Promise<{ access_token: string; videoId: string; eTag: string }> {
    const { access_token } = await registerConfirmAndLogin(email);

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        originalFilename: 'trip.mp4',
        fileSizeBytes: 1_000_000,
        mimeType: 'video/mp4',
      });
    const body = res.body as CreateVideoResponse;

    const uploadResponse = await fetch(body.parts[0].uploadUrl, {
      method: 'PUT',
      body: Buffer.from('integration-test-part-bytes'),
    });
    const eTag = uploadResponse.headers.get('etag') ?? '';

    return { access_token, videoId: body.id, eTag };
  }

  async function createDraftVideo(
    email: string,
  ): Promise<{ access_token: string; videoId: string }> {
    const { access_token } = await registerConfirmAndLogin(email);

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${access_token}`)
      .send({
        originalFilename: 'trip.mp4',
        fileSizeBytes: 1_000_000,
        mimeType: 'video/mp4',
      });
    const body = res.body as CreateVideoResponse;

    return { access_token, videoId: body.id };
  }

  function decodeJwtSub(token: string): string {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64').toString('utf8'),
    ) as { sub: string };
    return decoded.sub;
  }

  async function createVideoWithStatus(
    email: string,
    status: VideoStatus,
    overrides: { thumbnailKey?: string | null } = {},
  ): Promise<{ access_token: string; videoId: string }> {
    const { access_token } = await registerConfirmAndLogin(email);
    const userId = decodeJwtSub(access_token);
    const channelsService = app.get(ChannelsService);
    const channel = await channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error('Channel not found for test fixture user');
    }

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'fixture',
        original_filename: 'fixture.mp4',
        object_key: `${channel.id}/${randomUUID()}/original.mp4`,
        status,
        thumbnail_key: overrides.thumbnailKey ?? null,
      }),
    );

    return { access_token, videoId: video.id };
  }

  async function createReadyVideoWithRealObject(
    email: string,
  ): Promise<{ access_token: string; videoId: string }> {
    const { access_token, videoId } = await createVideoWithStatus(
      email,
      VideoStatus.READY,
      { thumbnailKey: 'ch/vid/thumbnail.jpg' },
    );
    const video = await videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new Error('Fixture video not found after creation');
    }

    const tmpFile = join(tmpdir(), `e2e-video-${randomUUID()}.mp4`);
    writeFileSync(tmpFile, 'fake-video-bytes');
    try {
      await app
        .get(StorageService)
        .uploadObject('videos', video.object_key, tmpFile, 'video/mp4');
    } finally {
      unlinkSync(tmpFile);
    }

    return { access_token, videoId };
  }

  describe('POST /videos', () => {
    it('derives-title-from-filename', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-owner-1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          originalFilename: 'trip.mp4',
          fileSizeBytes: 1_000_000,
          mimeType: 'video/mp4',
        })
        .expect(201);

      const body = res.body as CreateVideoResponse;
      expect(body.title).toBe('trip');

      const getRes = await request(app.getHttpServer())
        .get(`/videos/${body.id}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);
      expect((getRes.body as VideoDetailsResponse).status).toBe('draft');
    });

    it('rejects-file-size-over-10gb', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-owner-2@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          originalFilename: 'huge.mp4',
          fileSizeBytes: 10 * 1024 ** 3 + 1,
          mimeType: 'video/mp4',
        })
        .expect(413);

      expect((res.body as ErrorBody).error).toBe('FILE_TOO_LARGE');
    });

    it('initiates-real-multipart-upload', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'video-owner-3@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          originalFilename: 'clip.mp4',
          fileSizeBytes: 1_000_000,
          mimeType: 'video/mp4',
        })
        .expect(201);

      const body = res.body as CreateVideoResponse;
      expect(body.uploadId).toBeTruthy();
      expect(body.objectKey).toMatch(/^.+\/.+\/original\.mp4$/);
      expect(body.parts.length).toBeGreaterThanOrEqual(1);
      expect(body.parts[0]).toMatchObject({ partNumber: 1 });

      const uploadResponse = await fetch(body.parts[0].uploadUrl, {
        method: 'PUT',
        body: Buffer.from('integration-test-part-bytes'),
      });
      expect(uploadResponse.status).toBe(200);
      expect(uploadResponse.headers.get('etag')).toBeTruthy();
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    beforeEach(async () => {
      await videoQueue.obliterate({ force: true });
    });

    it('completes-upload-and-transitions-to-processing', async () => {
      const { access_token, videoId, eTag } =
        await createDraftVideoWithUploadedPart('complete-owner-1@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const body = res.body as CompleteUploadResponse;
      expect(body).toEqual({ id: videoId, status: 'processing' });
    });

    it('publishes-exactly-one-video-process-job', async () => {
      const { access_token, videoId, eTag } =
        await createDraftVideoWithUploadedPart('complete-owner-2@example.com');

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const jobs = await videoQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ]);
      const matchingJobs = jobs.filter(
        (job) => job.name === 'video.process' && job.data.videoId === videoId,
      );
      expect(matchingJobs).toHaveLength(1);
    });

    it('rejects-non-draft-video', async () => {
      const { access_token, videoId, eTag } =
        await createDraftVideoWithUploadedPart('complete-owner-3@example.com');
      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_ALREADY_COMPLETED');
    });

    it('masks-video-not-owned', async () => {
      const { videoId, eTag } = await createDraftVideoWithUploadedPart(
        'complete-owner-4@example.com',
      );
      const { access_token: otherAccessToken } = await registerConfirmAndLogin(
        'complete-intruder-1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('POST /videos/:id/abort-upload', () => {
    it('aborts-and-removes-draft', async () => {
      const { access_token, videoId } = await createDraftVideo(
        'abort-owner-1@example.com',
      );

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/abort-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(204);

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(404);
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects-non-draft-video', async () => {
      const { access_token, videoId, eTag } =
        await createDraftVideoWithUploadedPart('abort-owner-2@example.com');
      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/abort-upload`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_ALREADY_COMPLETED');
    });

    it('masks-video-not-owned', async () => {
      const { videoId } = await createDraftVideo('abort-owner-3@example.com');
      const { access_token: otherAccessToken } = await registerConfirmAndLogin(
        'abort-intruder-1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/abort-upload`)
        .set('Authorization', `Bearer ${otherAccessToken}`)
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id', () => {
    it('ready-video-visible-to-anyone', async () => {
      const { videoId } = await createVideoWithStatus(
        'get-owner-1@example.com',
        VideoStatus.READY,
        { thumbnailKey: 'ch/vid/thumbnail.jpg' },
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .expect(200);

      const body = res.body as VideoDetailsResponse;
      expect(body).toMatchObject({
        id: videoId,
        title: 'fixture',
        status: 'ready',
      });
      expect(body.thumbnailUrl).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
    });

    it('non-ready-video-visible-to-owner', async () => {
      const { access_token, videoId } = await createVideoWithStatus(
        'get-owner-2@example.com',
        VideoStatus.DRAFT,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect((res.body as VideoDetailsResponse).status).toBe('draft');
    });

    it('non-ready-video-masked-for-others', async () => {
      const { videoId } = await createVideoWithStatus(
        'get-owner-3@example.com',
        VideoStatus.DRAFT,
      );
      const { access_token: intruderToken } = await registerConfirmAndLogin(
        'get-intruder-1@example.com',
      );

      const anonRes = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .expect(404);
      expect((anonRes.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');

      const authedRes = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .expect(404);
      expect((authedRes.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('thumbnail-url-only-when-ready', async () => {
      const { access_token, videoId } = await createVideoWithStatus(
        'get-owner-4@example.com',
        VideoStatus.PROCESSING,
      );

      const processingRes = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);
      expect((processingRes.body as VideoDetailsResponse).thumbnailUrl).toBeNull();

      await videoRepository.update(videoId, {
        status: VideoStatus.READY,
        thumbnail_key: 'ch/vid/thumbnail.jpg',
      });

      const readyRes = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .expect(200);
      expect(
        (readyRes.body as VideoDetailsResponse).thumbnailUrl,
      ).toBeTruthy();
    });
  });

  describe('GET /videos/:id/stream', () => {
    it('ready-video-streams-for-anyone', async () => {
      const { videoId } = await createReadyVideoWithRealObject(
        'stream-owner-1@example.com',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .expect(302);

      const location = res.headers.location as string;
      expect(location).toBeTruthy();

      const fetched = await fetch(location);
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe('fake-video-bytes');
    });

    it('owner-non-ready-gets-not-ready', async () => {
      const { access_token, videoId } = await createVideoWithStatus(
        'stream-owner-2@example.com',
        VideoStatus.PROCESSING,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
    });

    it('non-owner-non-ready-masked', async () => {
      const { videoId } = await createVideoWithStatus(
        'stream-owner-3@example.com',
        VideoStatus.PROCESSING,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/download', () => {
    it('ready-video-downloads-for-anyone', async () => {
      const { videoId } = await createReadyVideoWithRealObject(
        'download-owner-1@example.com',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .expect(302);

      const location = res.headers.location as string;
      expect(location).toContain('response-content-disposition=attachment');

      const fetched = await fetch(location);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-disposition')).toBe('attachment');
      expect(await fetched.text()).toBe('fake-video-bytes');
    });

    it('owner-non-ready-gets-not-ready', async () => {
      const { access_token, videoId } = await createVideoWithStatus(
        'download-owner-2@example.com',
        VideoStatus.PROCESSING,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
    });

    it('non-owner-non-ready-masked', async () => {
      const { videoId } = await createVideoWithStatus(
        'download-owner-3@example.com',
        VideoStatus.PROCESSING,
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
