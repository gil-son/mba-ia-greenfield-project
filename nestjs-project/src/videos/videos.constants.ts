export const MAX_VIDEO_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const MULTIPART_PART_SIZE_BYTES = 100 * 1024 * 1024;

export const ACCEPTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
] as const;
