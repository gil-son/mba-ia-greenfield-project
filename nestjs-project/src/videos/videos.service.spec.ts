import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
} from './exceptions/video.exception';
import { VideosService } from './videos.service';

describe('VideosService — initiateUpload', () => {
  let videosService: VideosService;

  const channel = { id: 'channel-1' } as Channel;
  const dto: CreateVideoDto = {
    originalFilename: 'trip.mp4',
    fileSizeBytes: 1_000_000,
    mimeType: 'video/mp4',
  };

  const createMock = jest.fn((v: Partial<Video>) => v as Video);
  const saveMock = jest.fn(
    (v: Partial<Video>) =>
      Promise.resolve({ id: 'video-1', ...v }) as Promise<Video>,
  );
  const findByUserIdMock = jest.fn(() => Promise.resolve(channel));
  const createMultipartUploadMock = jest.fn(() =>
    Promise.resolve({
      uploadId: 'upload-1',
      objectKey: 'channel-1/video-1/original.mp4',
    }),
  );
  const getPresignedUploadPartUrlsMock = jest.fn(() =>
    Promise.resolve([
      { partNumber: 1, uploadUrl: 'https://minio.local/part-1' },
    ]),
  );
  const queueAddMock = jest.fn(() => Promise.resolve());

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: { create: createMock, save: saveMock },
        },
        {
          provide: ChannelsService,
          useValue: { findByUserId: findByUserIdMock },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: createMultipartUploadMock,
            getPresignedUploadPartUrls: getPresignedUploadPartUrlsMock,
          },
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: { add: queueAddMock },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('derives title from originalFilename and persists status=draft by default', async () => {
    const result = await videosService.initiateUpload('user-1', dto);

    expect(result.title).toBe('trip');
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'trip' }),
    );
    const savedVideo = saveMock.mock.calls[0][0];
    expect(savedVideo.status).toBeUndefined();
  });

  it('rejects fileSizeBytes above the 10GB limit before calling StorageService', async () => {
    const oversized: CreateVideoDto = {
      ...dto,
      fileSizeBytes: 10 * 1024 ** 3 + 1,
    };

    await expect(
      videosService.initiateUpload('user-1', oversized),
    ).rejects.toThrow(FileTooLargeException);
    expect(createMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported mimeType before calling StorageService', async () => {
    const unsupported: CreateVideoDto = { ...dto, mimeType: 'text/plain' };

    await expect(
      videosService.initiateUpload('user-1', unsupported),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(createMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('calls StorageService.createMultipartUpload exactly once and persists the returned uploadId', async () => {
    const result = await videosService.initiateUpload('user-1', dto);

    expect(findByUserIdMock).toHaveBeenCalledWith('user-1');
    expect(createMultipartUploadMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ upload_id: 'upload-1' }),
    );
    expect(result.uploadId).toBe('upload-1');
  });
});

describe('VideosService — completeUpload', () => {
  let videosService: VideosService;

  const completeDto: CompleteUploadDto = {
    parts: [{ partNumber: 1, eTag: 'etag-1' }],
  };

  const findOneMock = jest.fn();
  const saveMock = jest.fn(
    (v: Partial<Video>) => Promise.resolve(v) as Promise<Video>,
  );
  const completeMultipartUploadMock = jest.fn(() => Promise.resolve());
  const queueAddMock = jest.fn(() => Promise.resolve());

  function buildDraftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      title: 'trip',
      original_filename: 'trip.mp4',
      status: VideoStatus.DRAFT,
      object_key: 'channel-1/video-1/original.mp4',
      upload_id: 'upload-1',
      thumbnail_key: null,
      duration_seconds: null,
      size_bytes: null,
      mime_type: null,
      failure_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      channel: { id: 'channel-1', user_id: 'owner-1' } as Channel,
      ...overrides,
    } as Video;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOne: findOneMock, save: saveMock },
        },
        { provide: ChannelsService, useValue: {} },
        {
          provide: StorageService,
          useValue: { completeMultipartUpload: completeMultipartUploadMock },
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: { add: queueAddMock },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('completes the upload of a draft video and transitions status to processing', async () => {
    findOneMock.mockResolvedValue(buildDraftVideo());

    const result = await videosService.completeUpload(
      'video-1',
      'owner-1',
      completeDto,
    );

    expect(completeMultipartUploadMock).toHaveBeenCalledWith(
      'channel-1/video-1/original.mp4',
      'upload-1',
      completeDto.parts,
    );
    expect(result.status).toBe(VideoStatus.PROCESSING);
  });

  it('publishes exactly one video.process job with { videoId, objectKey }', async () => {
    findOneMock.mockResolvedValue(buildDraftVideo());

    await videosService.completeUpload('video-1', 'owner-1', completeDto);

    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledWith(
      'video.process',
      { videoId: 'video-1', objectKey: 'channel-1/video-1/original.mp4' },
      expect.anything(),
    );
  });

  it('throws UPLOAD_ALREADY_COMPLETED for a non-draft video without calling StorageService', async () => {
    findOneMock.mockResolvedValue(
      buildDraftVideo({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      videosService.completeUpload('video-1', 'owner-1', completeDto),
    ).rejects.toThrow(UploadAlreadyCompletedException);
    expect(completeMultipartUploadMock).not.toHaveBeenCalled();
  });

  it('throws VIDEO_NOT_FOUND when the video does not belong to ownerId', async () => {
    findOneMock.mockResolvedValue(
      buildDraftVideo({
        channel: { id: 'channel-1', user_id: 'someone-else' } as Channel,
      }),
    );

    await expect(
      videosService.completeUpload('video-1', 'owner-1', completeDto),
    ).rejects.toThrow(VideoNotFoundException);
  });
});

describe('VideosService — abortUpload', () => {
  let videosService: VideosService;

  const findOneMock = jest.fn();
  const removeMock = jest.fn((v: Video) => Promise.resolve(v));
  const abortMultipartUploadMock = jest.fn(() => Promise.resolve());

  function buildDraftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      title: 'trip',
      original_filename: 'trip.mp4',
      status: VideoStatus.DRAFT,
      object_key: 'channel-1/video-1/original.mp4',
      upload_id: 'upload-1',
      thumbnail_key: null,
      duration_seconds: null,
      size_bytes: null,
      mime_type: null,
      failure_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      channel: { id: 'channel-1', user_id: 'owner-1' } as Channel,
      ...overrides,
    } as Video;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOne: findOneMock, remove: removeMock },
        },
        { provide: ChannelsService, useValue: {} },
        {
          provide: StorageService,
          useValue: { abortMultipartUpload: abortMultipartUploadMock },
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  it('aborts the upload of a draft video and removes it from the DB', async () => {
    const video = buildDraftVideo();
    findOneMock.mockResolvedValue(video);

    await videosService.abortUpload('video-1', 'owner-1');

    expect(abortMultipartUploadMock).toHaveBeenCalledWith(
      'channel-1/video-1/original.mp4',
      'upload-1',
    );
    expect(removeMock).toHaveBeenCalledWith(video);
  });

  it('throws UPLOAD_ALREADY_COMPLETED for a non-draft video without removing it', async () => {
    findOneMock.mockResolvedValue(
      buildDraftVideo({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      videosService.abortUpload('video-1', 'owner-1'),
    ).rejects.toThrow(UploadAlreadyCompletedException);
    expect(abortMultipartUploadMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('throws VIDEO_NOT_FOUND when the video does not belong to ownerId', async () => {
    findOneMock.mockResolvedValue(
      buildDraftVideo({
        channel: { id: 'channel-1', user_id: 'someone-else' } as Channel,
      }),
    );

    await expect(
      videosService.abortUpload('video-1', 'owner-1'),
    ).rejects.toThrow(VideoNotFoundException);
  });
});
