import { randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
  UploadAlreadyCompletedException,
  UploadCompletionFailedException,
  VideoNotFoundException,
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

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue('video-processing') private readonly queue: Queue,
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

  async completeUpload(
    videoId: string,
    ownerId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideoOrThrow(videoId, ownerId);
    this.assertDraft(video);

    if (!video.upload_id) {
      throw new Error('Draft video is missing uploadId');
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.object_key,
        video.upload_id,
        dto.parts,
      );
    } catch {
      throw new UploadCompletionFailedException();
    }

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.queue.add(
      'video.process',
      { videoId: saved.id, objectKey: saved.object_key },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    return { id: saved.id, status: saved.status };
  }

  async abortUpload(videoId: string, ownerId: string): Promise<void> {
    const video = await this.findOwnedVideoOrThrow(videoId, ownerId);
    this.assertDraft(video);

    if (!video.upload_id) {
      throw new Error('Draft video is missing uploadId');
    }

    await this.storageService.abortMultipartUpload(
      video.object_key,
      video.upload_id,
    );
    await this.videoRepository.remove(video);
  }

  private async findOwnedVideoOrThrow(
    videoId: string,
    ownerId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video || video.channel.user_id !== ownerId) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private assertDraft(video: Video): void {
    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadAlreadyCompletedException();
    }
  }
}
