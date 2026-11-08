import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { newId } from './domain/shared/id';
import { appLogger } from './infrastructure/observability/json-logger';
import { logContext } from './infrastructure/observability/log-context';
import { HttpExceptionFilter } from './interfaces/http/http-exception.filter';
import { setupSwagger } from './interfaces/http/openapi';

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;

/** Propaga (ou gera) o correlationId e abre o contexto de log da requisição. */
function correlation(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && SAFE_CORRELATION.test(incoming) ? incoming : newId();
  res.setHeader(CORRELATION_HEADER, correlationId);
  const startedAt = performance.now();
  logContext.run({ correlationId }, () => {
    res.on('finish', () => {
      appLogger.info('http.request', {
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    next();
  });
}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: appLogger, bufferLogs: true });
  app.use(correlation);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  setupSwagger(app);
  return app;
}

const SHUTDOWN_TIMEOUT_MS = 25_000;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();
  await app.listen(config.PORT);
  appLogger.info('app.started', { port: config.PORT, instanceId: config.INSTANCE_ID });

  // Shutdown gracioso: app.close() para de aceitar HTTP, roda beforeApplicationShutdown
  // (consumer devolve mensagens não iniciadas e conclui as em andamento; workers
  // terminam o ciclo corrente) e onApplicationShutdown (fecha SQS e pool do banco).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    appLogger.info('app.stopping', { signal });
    const force = setTimeout(() => {
      appLogger.error('app.shutdown.timeout', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      await app.close();
      appLogger.info('app.stopped', { signal });
      process.exit(0);
    } catch (error) {
      appLogger.error('app.shutdown.failed', error instanceof Error ? error : new Error(String(error)));
      process.exit(1);
    } finally {
      clearTimeout(force);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.main) {
  bootstrap().catch((error: unknown) => {
    appLogger.error('app.start.failed', error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  });
}
