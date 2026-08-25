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
