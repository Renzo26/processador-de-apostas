import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../../application/ports/observability';

/** Implementação Prometheus da porta de métricas, exposta em GET /metrics. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas, por kind/status/origem',
    labelNames: ['kind', 'status', 'source'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_detected_total',
    help: 'Duplicatas detectadas (idempotency key ou inbox)',
    labelNames: ['source', 'layer'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retentativas internas (corridas, referência pendente, SQS)',
    labelNames: ['operation', 'reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Conflitos de concorrência detectados pelo banco',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência de processamento de transações',
    labelNames: ['source', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly reconciliation = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Divergências entre saldo materializado e ledger',
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'sqs_messages_to_dlq_total',
    help: 'Mensagens encaminhadas à DLQ',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly published = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados a partir da outbox',
    registers: [this.registry],
  });
  private readonly publishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas de publicação da outbox',
    registers: [this.registry],
  });

  /** Atualizados pelo worker de outbox / consumer a cada ciclo. */
  readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Eventos aguardando publicação',
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo',
    registers: [this.registry],
  });
  readonly dlqDepth = new Gauge({
    name: 'sqs_dlq_approximate_messages',
    help: 'Mensagens na DLQ (ApproximateNumberOfMessages)',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionsTotal(l: { kind: string; status: string; source: string }): void {
    this.transactions.inc(l);
  }
  duplicateDetected(l: { source: string; layer: string }): void {
    this.duplicates.inc(l);
  }
  retry(l: { operation: string; reason: string }): void {
    this.retries.inc(l);
  }
  lockConflict(l: { operation: string }): void {
    this.lockConflicts.inc(l);
  }
  processingLatency(seconds: number, l: { source: string; status: string }): void {
    this.latency.observe(l, seconds);
  }
  reconciliationMismatch(): void {
    this.reconciliation.inc();
  }
  messageToDlq(l: { reason: string }): void {
    this.dlq.inc(l);
  }
  outboxPublished(count: number): void {
    this.published.inc(count);
  }
  outboxPublishFailed(): void {
    this.publishFailures.inc();
  }
}
