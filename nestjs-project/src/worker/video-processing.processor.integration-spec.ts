import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue, QueueEvents } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import {
  VideoProcessingProcessor,
  VideoProcessJobData,
} from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, Video];
const TEST_QUEUE_PREFIX = 'test-video-processing-processor-integration-spec';

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('VideoProcessingProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let queue: Queue<VideoProcessJobData>;
  let queueEvents: QueueEvents;

  const downloadObjectMock = jest.fn(() => Promise.resolve());
  const uploadObjectMock = jest.fn(() => Promise.resolve());
  const probeDurationMock = jest.fn(() => Promise.resolve(42));
  const extractThumbnailMock = jest.fn(() => Promise.resolve());

  beforeAll(async () => {
    jest.clearAllMocks();
    const ds = createTestDataSource(ALL_ENTITIES);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ConfigType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
            prefix: TEST_QUEUE_PREFIX,
          }),
        }),
        BullModule.registerQueue({ name: 'video-processing' }),
        ChannelsModule,
      ],
      providers: [
        VideoProcessingProcessor,
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

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    channelsService = module.get(ChannelsService);
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

  afterAll(async () => {
    await queueEvents.close();
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createProcessingVideo(): Promise<Video> {
    userCounter += 1;
    const userRepository = dataSource.getRepository(User);

    const user = await userRepository.save(
      userRepository.create({
        email: `worker_owner_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'trip',
        original_filename: 'trip.mp4',
        status: VideoStatus.PROCESSING,
        object_key: `${channel.id}/video-${userCounter}/original.mp4`,
      }),
    );
  }

  it('transitions a processing Video to ready with durationSeconds/thumbnailKey on success', async () => {
    const video = await createProcessingVideo();

    const job = await queue.add(
      'video.process',
      { videoId: video.id, objectKey: video.object_key },
      { attempts: 1 },
    );
    await job.waitUntilFinished(queueEvents, 10000);

    const saved = await videoRepository.findOneBy({ id: video.id });
    expect(saved?.status).toBe(VideoStatus.READY);
    expect(saved?.duration_seconds).toBe(42);
    expect(saved?.thumbnail_key).toBe(
      `${video.object_key.replace(/original\.[^./]+$/, 'thumbnail.jpg')}`,
    );
  }, 15000);

  it('transitions a processing Video to failed with failureReason once retries are exhausted', async () => {
    const video = await createProcessingVideo();
    probeDurationMock.mockRejectedValue(new Error('ffprobe: corrupted file'));

    const job = await queue.add(
      'video.process',
      { videoId: video.id, objectKey: video.object_key },
      { attempts: 1 },
    );
    await expect(job.waitUntilFinished(queueEvents, 10000)).rejects.toThrow();

    await waitFor(async () => {
      const saved = await videoRepository.findOneBy({ id: video.id });
      expect(saved?.status).toBe(VideoStatus.FAILED);
      expect(saved?.failure_reason).toBe('ffprobe: corrupted file');
    });
  }, 15000);
});
