import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
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

interface AuthServiceInternal {
  mailService: MailService;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

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
});
