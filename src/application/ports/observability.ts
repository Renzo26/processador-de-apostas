export type Labels = Record<string, string>;

/** Porta de métricas: a aplicação não conhece Prometheus. */
export interface Metrics {
  transactionsTotal(labels: { kind: string; status: string; source: string }): void;
  duplicateDetected(labels: { source: string; layer: 'idempotency_key' | 'inbox' }): void;
  retry(labels: { operation: string; reason: string }): void;
  lockConflict(labels: { operation: string }): void;
  processingLatency(seconds: number, labels: { source: string; status: string }): void;
  reconciliationMismatch(): void;
  messageToDlq(labels: { reason: string }): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(): void;
}

export const METRICS = Symbol('Metrics');

export const noopMetrics: Metrics = {
  transactionsTotal: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  lockConflict: () => {},
  processingLatency: () => {},
  reconciliationMismatch: () => {},
  messageToDlq: () => {},
  outboxPublished: () => {},
  outboxPublishFailed: () => {},
};

export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');

export const systemClock: Clock = { now: () => new Date() };
