import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  let tmpDir: string;
  let validVideoPath: string;
  let corruptedVideoPath: string;

  beforeAll(async () => {
    service = new FfmpegService();
    tmpDir = await mkdtemp(join(tmpdir(), 'ffmpeg-service-'));
    validVideoPath = join(tmpDir, 'valid.mp4');
    corruptedVideoPath = join(tmpDir, 'corrupted.mp4');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      validVideoPath,
    ]);
    await writeFile(corruptedVideoPath, 'not-a-real-video-file');
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('probeDuration returns the duration in seconds with 1s precision', async () => {
    const duration = await service.probeDuration(validVideoPath);

    expect(duration).toBe(2);
  });

  it('extractThumbnail generates an image file at outputPath', async () => {
    const outputPath = join(tmpDir, 'thumbnail.jpg');

    await service.extractThumbnail(validVideoPath, outputPath);

    const stats = await stat(outputPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('probeDuration rejects the promise for a corrupted file', async () => {
    await expect(service.probeDuration(corruptedVideoPath)).rejects.toThrow();
  });

  it('extractThumbnail rejects the promise for a corrupted file', async () => {
    const outputPath = join(tmpDir, 'corrupted-thumbnail.jpg');

    await expect(
      service.extractThumbnail(corruptedVideoPath, outputPath),
    ).rejects.toThrow();
  });
});
