import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
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
