import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION || 'us-east-1',
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'videos',
  thumbnailsBucket: process.env.STORAGE_THUMBNAILS_BUCKET || 'thumbnails',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY as string,
  },
}));
