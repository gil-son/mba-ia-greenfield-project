import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export type StorageBucket = 'videos' | 'thumbnails';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly s3: S3Client;
  private readonly videosBucket: string;
  private readonly thumbnailsBucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.videosBucket = config.videosBucket;
    this.thumbnailsBucket = config.thumbnailsBucket;
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: config.credentials,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket(this.videosBucket);
    await this.ensureBucket(this.thumbnailsBucket);
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }

  private resolveBucket(bucket: StorageBucket): string {
    return bucket === 'videos' ? this.videosBucket : this.thumbnailsBucket;
  }

  async createMultipartUpload(
    channelId: string,
    videoId: string,
    extension: string,
    contentType: string,
  ): Promise<{ uploadId: string; objectKey: string }> {
    const objectKey = `${channelId}/${videoId}/original.${extension}`;
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: objectKey,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(
        'StorageService.createMultipartUpload: object storage returned no UploadId',
      );
    }
    return { uploadId: UploadId, objectKey };
  }

  async getPresignedUploadPartUrls(
    objectKey: string,
    uploadId: string,
    partCount: number,
  ): Promise<{ partNumber: number; uploadUrl: string }[]> {
    return Promise.all(
      Array.from({ length: partCount }, (_, index) => index + 1).map(
        async (partNumber) => ({
          partNumber,
          uploadUrl: await getSignedUrl(
            this.s3,
            new UploadPartCommand({
              Bucket: this.videosBucket,
              Key: objectKey,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn: 3600 },
          ),
        }),
      ),
    );
  }

  async completeMultipartUpload(
    objectKey: string,
    uploadId: string,
    parts: { partNumber: number; eTag: string }[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: objectKey,
        UploadId: uploadId,
      }),
    );
  }

  async downloadObject(
    bucket: StorageBucket,
    objectKey: string,
    destinationPath: string,
  ): Promise<void> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.resolveBucket(bucket),
        Key: objectKey,
      }),
    );
    if (!Body) {
      throw new Error(
        `StorageService.downloadObject: object storage returned no Body for ${objectKey}`,
      );
    }
    await pipeline(Body as Readable, createWriteStream(destinationPath));
  }

  async uploadObject(
    bucket: StorageBucket,
    objectKey: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.resolveBucket(bucket),
        Key: objectKey,
        Body: createReadStream(filePath),
        ContentType: contentType,
      }),
    );
  }

  async getPresignedGetUrl(
    bucket: StorageBucket,
    objectKey: string,
    options: { expiresIn?: number } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.resolveBucket(bucket),
        Key: objectKey,
      }),
      { expiresIn: options.expiresIn ?? 3600 },
    );
  }
}
