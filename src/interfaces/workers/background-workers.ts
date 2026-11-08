import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { OutboxRelay } from '../../application/messaging/outbox-relay';
import type { OutboxStore } from '../../application/ports/messaging';
import type { PendingReferenceWorker } from '../../application/wagering/pending-reference-worker';
import type { AppConfig } from '../../config';
import type { QueueUrls } from '../../infrastructure/messaging/sqs';
import type { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import type { WagerTransactionsConsumer } from '../sqs/wager-transactions.consumer';
import { PollingLoop } from './polling-loop';

/**
 * Processos de fundo da instância. Todos são seguros com N instâncias em paralelo
 * (lease/SKIP LOCKED/inbox), então não há eleição de líder.
 *
 * Shutdown (SIGTERM → enableShutdownHooks): para de receber, conclui o trabalho
 * em andamento, e só então o AppModule fecha o pool do banco.
 */
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loops: PollingLoop[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly consumer: WagerTransactionsConsumer,
    relay: OutboxRelay,
    pendingReferences: PendingReferenceWorker,
    private readonly outboxStore: OutboxStore,
    private readonly metrics: PrometheusMetrics,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
  ) {
    if (config.OUTBOX_PUBLISHER_ENABLED) {
      this.loops.push(new PollingLoop('outbox-relay', config.OUTBOX_POLL_INTERVAL_MS, () => relay.runOnce()));
    }
    if (config.PENDING_REFERENCE_WORKER_ENABLED) {
      this.loops.push(new PollingLoop('pending-reference', config.PENDING_REFERENCE_POLL_INTERVAL_MS, () => pendingReferences.runOnce()));
    }
    this.loops.push(new PollingLoop('gauges', 5_000, () => this.refreshGauges().then(() => 0)));
  }

  onApplicationBootstrap(): void {
    if (this.config.SQS_CONSUMER_ENABLED) this.consumer.start();
    for (const loop of this.loops) loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(), ...this.loops.map((l) => l.stop())]);
  }

  private async refreshGauges(): Promise<void> {
    const stats = await this.outboxStore.stats(new Date());
    this.metrics.outboxPending.set(stats.pending);
    this.metrics.outboxLag.set(stats.oldestAgeSeconds);

    const dlqUrl = await this.queues.get(this.config.SQS_DLQ_NAME);
    const out = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
    this.metrics.dlqDepth.set(Number(out.Attributes?.ApproximateNumberOfMessages ?? 0));
  }
}
