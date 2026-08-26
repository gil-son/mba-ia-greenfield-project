import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const VIDEOS_BUCKET = process.env.STORAGE_VIDEOS_BUCKET || 'videos';
const THUMBNAILS_BUCKET = process.env.STORAGE_THUMBNAILS_BUCKET || 'thumbnails';

function randomId(): string {
  return Math.random().toString(36).slice(2);
}

describe('StorageService (integration)', () => {
  let app: INestApplication;
  let storageService: StorageService;
  let rawS3: S3Client;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    storageService = app.get(StorageService);

    rawS3 = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: process.env.STORAGE_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY as string,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('createMultipartUpload returns a valid uploadId and the objectKey format {channelId}/{videoId}/original.<ext>, in the videos bucket', async () => {
    const channelId = randomId();
    const videoId = randomId();

    const { uploadId, objectKey } = await storageService.createMultipartUpload(
      channelId,
      videoId,
      'mp4',
      'video/mp4',
    );

    expect(uploadId).toBeTruthy();
    expect(objectKey).toBe(`${channelId}/${videoId}/original.mp4`);

    await storageService.abortMultipartUpload(objectKey, uploadId);
  });

  it('never generates the same objectKey for two distinct videos', async () => {
    const channelId = randomId();

    const first = await storageService.createMultipartUpload(
      channelId,
      randomId(),
      'mp4',
      'video/mp4',
    );
    const second = await storageService.createMultipartUpload(
      channelId,
      randomId(),
      'mp4',
      'video/mp4',
    );

    expect(first.objectKey).not.toBe(second.objectKey);

    await storageService.abortMultipartUpload(first.objectKey, first.uploadId);
    await storageService.abortMultipartUpload(
      second.objectKey,
      second.uploadId,
    );
  });

  it('getPresignedGetUrl returns a working presigned URL against MinIO for the videos bucket', async () => {
    const key = `${randomId()}/${randomId()}/original.txt`;
    const body = 'integration-test-video-bytes';
    await rawS3.send(
      new PutObjectCommand({ Bucket: VIDEOS_BUCKET, Key: key, Body: body }),
    );

    const url = await storageService.getPresignedGetUrl('videos', key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it('getPresignedGetUrl returns a working presigned URL against MinIO for the thumbnails bucket', async () => {
    const key = `${randomId()}/${randomId()}/thumbnail.jpg`;
    const body = 'integration-test-thumbnail-bytes';
    await rawS3.send(
      new PutObjectCommand({ Bucket: THUMBNAILS_BUCKET, Key: key, Body: body }),
    );

    const url = await storageService.getPresignedGetUrl('thumbnails', key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it('getPresignedGetUrl applies responseContentDisposition to force a download', async () => {
    const key = `${randomId()}/${randomId()}/original.txt`;
    const body = 'integration-test-download-bytes';
    await rawS3.send(
      new PutObjectCommand({ Bucket: VIDEOS_BUCKET, Key: key, Body: body }),
    );

    const url = await storageService.getPresignedGetUrl('videos', key, {
      responseContentDisposition: 'attachment',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(await response.text()).toBe(body);
  });

  it('downloadObject writes the object bytes to the given destinationPath', async () => {
    const key = `${randomId()}/${randomId()}/original.txt`;
    const body = 'integration-test-download-bytes';
    await rawS3.send(
      new PutObjectCommand({ Bucket: VIDEOS_BUCKET, Key: key, Body: body }),
    );
    const tmpDir = await mkdtemp(join(tmpdir(), 'storage-service-'));
    const destinationPath = join(tmpDir, 'downloaded.txt');

    await storageService.downloadObject('videos', key, destinationPath);

    expect(await readFile(destinationPath, 'utf-8')).toBe(body);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uploadObject puts the local file bytes into the thumbnails bucket', async () => {
    const key = `${randomId()}/${randomId()}/thumbnail.jpg`;
    const body = 'integration-test-upload-bytes';
    const tmpDir = await mkdtemp(join(tmpdir(), 'storage-service-'));
    const sourcePath = join(tmpDir, 'thumbnail.jpg');
    await writeFile(sourcePath, body);

    await storageService.uploadObject(
      'thumbnails',
      key,
      sourcePath,
      'image/jpeg',
    );

    const { Body } = await rawS3.send(
      new GetObjectCommand({ Bucket: THUMBNAILS_BUCKET, Key: key }),
    );
    expect(await Body?.transformToString()).toBe(body);
    await rm(tmpDir, { recursive: true, force: true });
  });
});
