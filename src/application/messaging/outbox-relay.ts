import type { EventPublisher, OutboxStore } from '../ports/messaging';
import type { Clock, Metrics } from '../ports/observability';

export interface OutboxRelayOptions {
  owner: string;
  batchSize: number;
  leaseMs: number;
}

/**
 * Transactional Outbox relay: lê eventos já commitados e os publica.
 *
 * Garantia: at-least-once. Um evento só sai da outbox depois de publicado com
 * sucesso; se o processo morrer entre publicar e marcar, o lease expira e o
 * evento é publicado de novo — com o MESMO eventId, que o consumidor usa para
 * deduplicar (e o SQS FIFO também, via MessageDeduplicationId).
 */
export class OutboxRelay {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly options: OutboxRelayOptions,
  ) {}

  /** Um ciclo. Retorna quantas mensagens foram publicadas. */
  async runOnce(): Promise<number> {
    const claimed = await this.store.claim(this.options.owner, this.options.batchSize, this.options.leaseMs, this.clock.now());
    if (claimed.length === 0) return 0;

    const results = await this.publisher.publish(claimed);
    let published = 0;
    for (const message of claimed) {
      const result = results.get(message.id) ?? { ok: false as const, error: 'no result from publisher' };
      if (result.ok) {
        message.markPublished(this.clock.now());
        published++;
      } else {
        message.scheduleRetry(this.clock.now(), result.error);
        this.metrics.outboxPublishFailed();
        this.metrics.retry({ operation: 'outbox_publish', reason: 'publish_failed' });
      }
      await this.store.release(this.options.owner, message);
    }
    if (published > 0) this.metrics.outboxPublished(published);
    return published;
  }
}
