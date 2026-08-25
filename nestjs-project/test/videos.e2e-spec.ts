import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';

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

      // SI-03.7 (GET /videos/:id) is not yet implemented — the persisted
      // status is asserted directly against the DB instead of via HTTP.
      const saved = await videoRepository.findOneBy({ id: body.id });
      expect(saved?.status).toBe('draft');
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

      // SI-03.7 (GET /videos/:id) is not yet implemented — removal is
      // asserted directly against the DB instead of via HTTP.
      const saved = await videoRepository.findOneBy({ id: videoId });
      expect(saved).toBeNull();
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
});
