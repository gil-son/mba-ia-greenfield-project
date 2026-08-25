import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';

interface FfprobeFormat {
  format?: {
    duration?: string;
  };
}

@Injectable()
export class FfmpegService {
  async probeDuration(filePath: string): Promise<number> {
    const { stdout } = await this.run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeFormat;
    const duration = parsed.format?.duration;
    if (!duration) {
      throw new Error(`ffprobe: could not determine duration for ${filePath}`);
    }
    return Math.round(Number(duration));
  }

  async extractThumbnail(filePath: string, outputPath: string): Promise<void> {
    await this.run('ffmpeg', [
      '-y',
      '-i',
      filePath,
      '-ss',
      '00:00:00',
      '-vframes',
      '1',
      outputPath,
    ]);
  }

  private run(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(
              `${command} exited with code ${code ?? 'null'}: ${stderr}`,
            ),
          );
        }
      });
    });
  }
}
