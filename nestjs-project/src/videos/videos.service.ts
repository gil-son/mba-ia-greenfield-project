import { randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
} from './exceptions/video.exception';
import {
  ACCEPTED_VIDEO_MIME_TYPES,
  MAX_VIDEO_FILE_SIZE_BYTES,
  MULTIPART_PART_SIZE_BYTES,
} from './videos.constants';

export interface InitiateUploadResult {
  id: string;
  title: string;
  uploadId: string;
  objectKey: string;
  partSizeBytes: number;
  parts: { partNumber: number; uploadUrl: string }[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.fileSizeBytes > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }
    if (
      !ACCEPTED_VIDEO_MIME_TYPES.includes(
        dto.mimeType as (typeof ACCEPTED_VIDEO_MIME_TYPES)[number],
      )
    ) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error('Channel not found for authenticated user');
    }

    const videoId = randomUUID();
    const extension = extname(dto.originalFilename).slice(1);
    const title = basename(dto.originalFilename, extname(dto.originalFilename));

    const { uploadId, objectKey } =
      await this.storageService.createMultipartUpload(
        channel.id,
        videoId,
        extension,
        dto.mimeType,
      );

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        id: videoId,
        channel_id: channel.id,
        title,
        original_filename: dto.originalFilename,
        object_key: objectKey,
        upload_id: uploadId,
      }),
    );

    const partCount = Math.max(
      1,
      Math.ceil(dto.fileSizeBytes / MULTIPART_PART_SIZE_BYTES),
    );
    const parts = await this.storageService.getPresignedUploadPartUrls(
      objectKey,
      uploadId,
      partCount,
    );

    return {
      id: video.id,
      title: video.title,
      uploadId,
      objectKey,
      partSizeBytes: MULTIPART_PART_SIZE_BYTES,
      parts,
    };
  }
}
