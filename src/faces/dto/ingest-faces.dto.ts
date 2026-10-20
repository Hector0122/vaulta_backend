import {
  IsArray,
  IsString,
  IsNumber,
  IsOptional,
  ArrayMinSize,
  ArrayMaxSize,
  Min,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

class FaceResultDto {
  @IsArray()
  @ArrayMinSize(128)
  @ArrayMaxSize(128)
  @IsNumber({}, { each: true })
  encoding: number[];

  @IsNumber()
  boxX: number;

  @IsNumber()
  boxY: number;

  @IsNumber()
  @Min(1)
  boxWidth: number;

  @IsNumber()
  @Min(1)
  boxHeight: number;

  @IsOptional()
  @IsString()
  personName?: string;
}

class PhotoResultDto {
  @IsString()
  photoId: string;

  // Empty means "scanned, no faces" — the photo still gets facesScannedAt.
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaceResultDto)
  faces: FaceResultDto[];
}

export class IngestFacesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PhotoResultDto)
  results: PhotoResultDto[];
}
