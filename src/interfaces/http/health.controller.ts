import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config';
import { QueueUrls, SQS_CLIENT } from '../../infrastructure/messaging/sqs';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/** Endpoints abertos (sem autenticação): health e métricas. */
@ApiTags('Operação')
@Controller()
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QueueUrls) private readonly queues: QueueUrls,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: o processo responde. Não consulta dependências (evita restart em cascata). */
  @Get('health/live')
  @ApiOperation({ summary: 'Liveness: o processo está vivo (não consulta dependências)' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok' } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 tira a instância do balanceamento. */
  @Get('health/ready')
  @ApiOperation({ summary: 'Readiness: PostgreSQL e SQS alcançáveis' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok', checks: { database: 'up', sqs: 'up' } } } })
  @ApiResponse({ status: 503, schema: { example: { status: 'unavailable', checks: { database: 'down', sqs: 'up' } } } })
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().execute('SELECT 1')),
      this.check(async () => {
        const url = await this.queues.get(this.config.SQS_QUEUE_NAME);
        await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
      }),
    ]);
    const ok = database === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { database, sqs } };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Métricas no formato Prometheus' })
  @ApiProduces('text/plain')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async prometheus(): Promise<string> {
    return this.metrics.registry.metrics();
  }

  private async check(fn: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await withTimeout(fn(), CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
