import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  let videoCounter = 0;
  function buildVideo(channelId: string) {
    videoCounter += 1;
    return {
      channel_id: channelId,
      title: `Video ${videoCounter}`,
      original_filename: `video-${videoCounter}.mp4`,
      object_key: `${channelId}/video-${videoCounter}/original.mp4`,
    };
  }

  it('should enforce unique object_key constraint', async () => {
    const channel = await createChannel();
    const objectKey = `${channel.id}/dup/original.mp4`;

    await videoRepository.save(
      videoRepository.create({
        ...buildVideo(channel.id),
        object_key: objectKey,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          ...buildVideo(channel.id),
          object_key: objectKey,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should fail to insert a video without channel_id (not-null violation)', async () => {
    const video = videoRepository.create({
      title: 'No channel',
      original_filename: 'file.mp4',
      object_key: 'no-channel/original.mp4',
    });

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should default status to draft when not explicitly set', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });
});
