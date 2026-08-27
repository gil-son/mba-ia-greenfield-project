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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentUserOrNull } from '../auth/decorators/current-user-or-null.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
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

const VIDEO_ID_PARAM = {
  name: 'id',
  description: 'Video id',
  type: String,
  format: 'uuid',
};

export interface VideoDetailsResponse {
  id: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  createdAt: Date;
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiBody({ type: CreateVideoDto })
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers a video as a draft owned by the authenticated user and initiates an S3 multipart upload, returning presigned URLs for each part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        uploadId: { type: 'string' },
        objectKey: { type: 'string' },
        partSizeBytes: { type: 'number' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              uploadUrl: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'FILE_TOO_LARGE — fileSizeBytes exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description:
      'UNSUPPORTED_MEDIA_TYPE — mimeType is not an accepted video format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam(VIDEO_ID_PARAM)
  @ApiBody({ type: CompleteUploadDto })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the S3 multipart upload with the given part ETags and enqueues the video for background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video moved to processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — video does not exist or is not owned by the authenticated user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'UPLOAD_ALREADY_COMPLETED — video is no longer in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 502,
    description:
      'UPLOAD_COMPLETION_FAILED — object storage rejected the multipart completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(id, user.sub, dto);
  }

  @Post(':id/abort-upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam(VIDEO_ID_PARAM)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the S3 multipart upload and removes the draft video record.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — video does not exist or is not owned by the authenticated user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'UPLOAD_ALREADY_COMPLETED — video is no longer in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(id, user.sub);
  }

  @Get(':id')
  @OptionalAuth()
  @ApiParam(VIDEO_ID_PARAM)
  @ApiOperation({
    summary: 'Get video details',
    description:
      "Returns the video's status and metadata. Anonymous-readable once the video is ready; otherwise visible only to its owner (Visibility rule).",
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['draft', 'processing', 'ready', 'failed'],
        },
        durationSeconds: { type: 'number', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — video does not exist, or is not ready and the requester is not its owner (existence masked)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
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
  @ApiParam(VIDEO_ID_PARAM)
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a time-limited presigned GET URL against object storage, supporting Range requests natively. Anonymous-readable once the video is ready; otherwise only its owner may request it (Visibility rule).',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirect to a presigned GET URL supporting byte-range requests',
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — video does not exist, or is not ready and the requester is not its owner (existence masked)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'VIDEO_NOT_READY — video exists, requester is its owner, but status is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
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
  @ApiParam(VIDEO_ID_PARAM)
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a time-limited presigned GET URL with a Content-Disposition: attachment override, forcing a full download. Anonymous-readable once the video is ready; otherwise only its owner may request it (Visibility rule).',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirect to a presigned GET URL with Content-Disposition: attachment',
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — video does not exist, or is not ready and the requester is not its owner (existence masked)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'VIDEO_NOT_READY — video exists, requester is its owner, but status is not ready yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUserOrNull() user: JwtPayload | null,
    @Param('id') id: string,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getDownloadUrl(id, user?.sub ?? null);
    return { url };
  }
}
