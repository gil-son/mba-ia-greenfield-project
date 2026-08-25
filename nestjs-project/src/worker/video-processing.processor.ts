import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';

export interface VideoProcessJobData {
  videoId: string;
  objectKey: string;
}

@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId, objectKey } = job.data;
    const workDir = await mkdtemp(
      join(tmpdir(), `video-processing-${videoId}-`),
    );
    const originalPath = join(workDir, 'original');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.storageService.downloadObject(
        'videos',
        objectKey,
        originalPath,
      );

      const durationSeconds =
        await this.ffmpegService.probeDuration(originalPath);
      await this.ffmpegService.extractThumbnail(originalPath, thumbnailPath);

      const thumbnailKey = objectKey.replace(
        /original\.[^./]+$/,
        'thumbnail.jpg',
      );
      await this.storageService.uploadObject(
        'thumbnails',
        thumbnailKey,
        thumbnailPath,
        'image/jpeg',
      );

      await this.videoRepository.update(
        { id: videoId },
        {
          status: VideoStatus.READY,
          duration_seconds: durationSeconds,
          thumbnail_key: thumbnailKey,
        },
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessJobData>, error: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      return;
    }
    try {
      await this.videoRepository.update(
        { id: job.data.videoId },
        { status: VideoStatus.FAILED, failure_reason: error.message },
      );
    } catch (updateError) {
      this.logger.error(
        `Failed to mark video ${job.data.videoId} as failed after exhausting retries`,
        updateError,
      );
    }
  }
}
