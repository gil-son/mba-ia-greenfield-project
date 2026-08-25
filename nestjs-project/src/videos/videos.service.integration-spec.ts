import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService — initiateUpload (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let channelsService: ChannelsService;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        ChannelsModule,
      ],
      providers: [VideosService],
    }).compile();

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
