import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  originalFilename: string;

  @IsInt()
  @IsPositive()
  fileSizeBytes: number;

  @IsString()
  @IsNotEmpty()
  mimeType: string;
}
