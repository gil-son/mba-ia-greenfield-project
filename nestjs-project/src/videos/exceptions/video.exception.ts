import { DomainException } from '../../common/exceptions/domain.exception';

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 413, 'File size exceeds the 10GB limit');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'Mime type is not an accepted video format',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadAlreadyCompletedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_COMPLETED',
      409,
      'Video upload is no longer in draft status',
    );
  }
}

export class UploadCompletionFailedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_COMPLETION_FAILED',
      502,
      'Object storage rejected the multipart upload completion',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
