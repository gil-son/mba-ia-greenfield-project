import { randomUUID } from 'node:crypto';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

function buildTestModule(): Promise<TestingModule> {
  const ds = createTestDataSource(ALL_ENTITIES);
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, queueConfig],
      }),
      TypeOrmModule.forRoot(ds.options),
      TypeOrmModule.forFeature([Video]),
      BullModule.forRootAsync({
        inject: [queueConfig.KEY],
        useFactory: (queue: ConfigType<typeof queueConfig>) => ({
          connection: { host: queue.host, port: queue.port },
        }),
      }),
      BullModule.registerQueue({ name: 'video-processing' }),
      StorageModule,
      ChannelsModule,
    ],
    providers: [VideosService],
  }).compile();
}

describe('VideosService — initiateUpload (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    module = await buildTestModule();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    storageService = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{ userId: string }> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    return { userId: user.id };
  }

  it('persists a Video in draft status with title derived from originalFilename', async () => {
    const { userId } = await createUserWithChannel();
    const dto: CreateVideoDto = {
      originalFilename: 'trip.mp4',
      fileSizeBytes: 1_000_000,
      mimeType: 'video/mp4',
    };

    const result = await videosService.initiateUpload(userId, dto);

    const saved = await videoRepository.findOneBy({ id: result.id });
    expect(saved).not.toBeNull();
    expect(saved?.title).toBe('trip');
    expect(saved?.status).toBe(VideoStatus.DRAFT);
    expect(saved?.upload_id).toBe(result.uploadId);
    expect(saved?.object_key).toBe(result.objectKey);

    await storageService.abortMultipartUpload(
      result.objectKey,
      result.uploadId,
    );
  });
});

describe('VideosService — completeUpload (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    module = await buildTestModule();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createDraftVideo(): Promise<{
    userId: string;
    videoId: string;
    completeDto: CompleteUploadDto;
  }> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `complete_owner_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);

    const initiated = await videosService.initiateUpload(user.id, {
      originalFilename: 'trip.mp4',
      fileSizeBytes: 1_000_000,
      mimeType: 'video/mp4',
    });

    const uploadResponse = await fetch(initiated.parts[0].uploadUrl, {
      method: 'PUT',
      body: Buffer.from('integration-test-part-bytes'),
    });
    const eTag = uploadResponse.headers.get('etag') ?? '';

    return {
      userId: user.id,
      videoId: initiated.id,
      completeDto: { parts: [{ partNumber: 1, eTag }] },
    };
  }

  it('transitions a draft Video to processing on the DB', async () => {
    const { userId, videoId, completeDto } = await createDraftVideo();

    const result = await videosService.completeUpload(
      videoId,
      userId,
      completeDto,
    );

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const saved = await videoRepository.findOneBy({ id: videoId });
    expect(saved?.status).toBe(VideoStatus.PROCESSING);
    expect(saved?.upload_id).toBeNull();
  });
});

describe('VideosService — abortUpload (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    module = await buildTestModule();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createDraftVideo(): Promise<{
    userId: string;
    videoId: string;
  }> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `abort_owner_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelsService.createChannel(user.id, user.email);

    const initiated = await videosService.initiateUpload(user.id, {
      originalFilename: 'trip.mp4',
      fileSizeBytes: 1_000_000,
      mimeType: 'video/mp4',
    });

    return { userId: user.id, videoId: initiated.id };
  }

  it('removes a draft Video from the DB', async () => {
    const { userId, videoId } = await createDraftVideo();

    await videosService.abortUpload(videoId, userId);

    const saved = await videoRepository.findOneBy({ id: videoId });
    expect(saved).toBeNull();
  });
});

describe('VideosService — findVisibleById (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    module = await buildTestModule();

    dataSource = module.get(DataSource);
    videosService = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createVideoWithStatus(
    status: VideoStatus,
  ): Promise<{ ownerId: string; videoId: string }> {
    userCounter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `visible_owner_${userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'fixture',
        original_filename: 'fixture.mp4',
        object_key: `${channel.id}/${randomUUID()}/original.mp4`,
        status,
      }),
    );

    return { ownerId: user.id, videoId: video.id };
  }

  it('returns null when the video does not exist', async () => {
    const result = await videosService.findVisibleById(randomUUID(), null);
    expect(result).toBeNull();
  });

  describe.each([
    VideoStatus.DRAFT,
    VideoStatus.PROCESSING,
    VideoStatus.FAILED,
  ])('when status is %s', (status) => {
    it('returns the video for its owner', async () => {
      const { ownerId, videoId } = await createVideoWithStatus(status);

      const result = await videosService.findVisibleById(videoId, ownerId);
      expect(result?.id).toBe(videoId);
    });

    it('returns null for an authenticated non-owner', async () => {
      const { videoId } = await createVideoWithStatus(status);

      const result = await videosService.findVisibleById(
        videoId,
        'someone-else',
      );
      expect(result).toBeNull();
    });

    it('returns null for an anonymous requester', async () => {
      const { videoId } = await createVideoWithStatus(status);

      const result = await videosService.findVisibleById(videoId, null);
      expect(result).toBeNull();
    });
  });

  describe('when status is ready', () => {
    it('returns the video regardless of requester', async () => {
      const { ownerId, videoId } = await createVideoWithStatus(
        VideoStatus.READY,
      );

      await expect(
        videosService.findVisibleById(videoId, ownerId),
      ).resolves.toMatchObject({ id: videoId });
      await expect(
        videosService.findVisibleById(videoId, 'someone-else'),
      ).resolves.toMatchObject({ id: videoId });
      await expect(
        videosService.findVisibleById(videoId, null),
      ).resolves.toMatchObject({ id: videoId });
    });
  });
});
