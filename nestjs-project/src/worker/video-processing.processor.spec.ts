import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import queueConfig from '../config/queue.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import {
  VideoProcessingProcessor,
  VideoProcessJobData,
} from './video-processing.processor';

const TEST_QUEUE_PREFIX = 'test-video-processing-processor-spec';

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('VideoProcessingProcessor', () => {
  let module: TestingModule;
  let queue: Queue<VideoProcessJobData>;
  let queueEvents: QueueEvents;

  const updateMock = jest.fn(() => Promise.resolve({ affected: 1 }));
  const downloadObjectMock = jest.fn(() => Promise.resolve());
  const uploadObjectMock = jest.fn(() => Promise.resolve());
  const probeDurationMock = jest.fn(() => Promise.resolve(42));
  const extractThumbnailMock = jest.fn(() => Promise.resolve());

  beforeEach(async () => {
    jest.clearAllMocks();

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ConfigType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
            prefix: TEST_QUEUE_PREFIX,
          }),
        }),
        BullModule.registerQueue({ name: 'video-processing' }),
      ],
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: { update: updateMock },
        },
        {
          provide: StorageService,
          useValue: {
            downloadObject: downloadObjectMock,
            uploadObject: uploadObjectMock,
          },
        },
        {
          provide: FfmpegService,
          useValue: {
            probeDuration: probeDurationMock,
            extractThumbnail: extractThumbnailMock,
          },
        },
      ],
    }).compile();
    await module.init();

    queue = module.get(getQueueToken('video-processing'));
    const queueCfg = module.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
    );
    queueEvents = new QueueEvents('video-processing', {
      connection: { host: queueCfg.host, port: queueCfg.port },
      prefix: TEST_QUEUE_PREFIX,
    });
    await queueEvents.waitUntilReady();
  });

  afterEach(async () => {
    await queueEvents.close();
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('processes a job successfully and updates the Video to ready with duration/thumbnailKey', async () => {
    const job = await queue.add(
      'video.process',
      { videoId: 'video-1', objectKey: 'channel-1/video-1/original.mp4' },
      { attempts: 1 },
    );

    await job.waitUntilFinished(queueEvents, 10000);

    expect(downloadObjectMock).toHaveBeenCalledWith(
      'videos',
      'channel-1/video-1/original.mp4',
      expect.any(String),
    );
    expect(uploadObjectMock).toHaveBeenCalledWith(
      'thumbnails',
      'channel-1/video-1/thumbnail.jpg',
      expect.any(String),
      'image/jpeg',
    );
    expect(updateMock).toHaveBeenCalledWith(
      { id: 'video-1' },
      {
        status: VideoStatus.READY,
        duration_seconds: 42,
        thumbnail_key: 'channel-1/video-1/thumbnail.jpg',
      },
    );
  }, 15000);

  it('retries a failed attempt without marking the Video as failed before attempts are exhausted', async () => {
    probeDurationMock
      .mockRejectedValueOnce(new Error('ffprobe transient failure'))
      .mockResolvedValueOnce(42);

    const job = await queue.add(
      'video.process',
      { videoId: 'video-2', objectKey: 'channel-1/video-2/original.mp4' },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );

    await job.waitUntilFinished(queueEvents, 10000);

    expect(probeDurationMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      { id: 'video-2' },
      expect.objectContaining({ status: VideoStatus.READY }),
    );
  }, 15000);

  it('marks the Video as failed with failureReason once retry attempts are exhausted', async () => {
    probeDurationMock.mockRejectedValue(new Error('ffprobe: corrupted file'));

    const job = await queue.add(
      'video.process',
      { videoId: 'video-3', objectKey: 'channel-1/video-3/original.mp4' },
      { attempts: 1 },
    );

    await expect(job.waitUntilFinished(queueEvents, 10000)).rejects.toThrow();

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith(
        { id: 'video-3' },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'ffprobe: corrupted file',
        },
      );
    });
  }, 15000);
});
