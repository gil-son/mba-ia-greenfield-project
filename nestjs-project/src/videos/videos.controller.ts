import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentUserOrNull } from '../auth/decorators/current-user-or-null.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoStatus } from './entities/video.entity';
import { VideoNotFoundException } from './exceptions/video.exception';
import {
  CompleteUploadResult,
  InitiateUploadResult,
  VideosService,
} from './videos.service';

export interface VideoDetailsResponse {
  id: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  createdAt: Date;
}

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(id, user.sub, dto);
  }

  @Post(':id/abort-upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(id, user.sub);
  }

  @Get(':id')
  @OptionalAuth()
  async findOne(
    @CurrentUserOrNull() user: JwtPayload | null,
    @Param('id') id: string,
  ): Promise<VideoDetailsResponse> {
    const video = await this.videosService.findVisibleById(
      id,
      user?.sub ?? null,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isReady = video.status === VideoStatus.READY;

    return {
      id: video.id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      thumbnailUrl:
        isReady && video.thumbnail_key
          ? await this.storageService.getPresignedGetUrl(
              'thumbnails',
              video.thumbnail_key,
            )
          : null,
      createdAt: video.created_at,
    };
  }

  @Get(':id/stream')
  @OptionalAuth()
  @Redirect()
  async stream(
    @CurrentUserOrNull() user: JwtPayload | null,
    @Param('id') id: string,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getStreamUrl(id, user?.sub ?? null);
    return { url };
  }

  @Get(':id/download')
  @OptionalAuth()
  @Redirect()
  async download(
    @CurrentUserOrNull() user: JwtPayload | null,
    @Param('id') id: string,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getDownloadUrl(
      id,
      user?.sub ?? null,
    );
    return { url };
  }
}
