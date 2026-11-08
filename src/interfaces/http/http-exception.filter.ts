import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { appLogger } from '../../infrastructure/observability/json-logger';
import { mapError } from './error-mapping';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(exception);

    if (mapped.status >= 500) {
      appLogger.error('http.request.failed', exception instanceof Error ? exception : new Error(String(exception)), 'HTTP');
    } else {
      appLogger.info('http.request.rejected', { status: mapped.status, code: mapped.body.error.code });
    }
    if (mapped.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    res.status(mapped.status).json(mapped.body);
  }
}
