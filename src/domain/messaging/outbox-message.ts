import type { IntegrationEvent, IntegrationEventEnvelope } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  lastError?: string | undefined;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

/**
 * Evento aguardando publicação. Gravado na mesma transação SQL da mudança de
 * estado que o originou — publicar antes do commit é impossível por construção.
 *
 * O id da mensagem é o próprio eventId: publicações duplicadas (at-least-once)
 * carregam o mesmo id e o consumidor deduplica por ele.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope: IntegrationEventEnvelope<unknown> = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...envelope }) as Readonly<Record<string, unknown>>,
      new Date(event.occurredAt),
      0,
      new Date(event.occurredAt),
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (this._publishedAt) return; // idempotente: republicação concorrente é segura
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial com teto). */
  scheduleRetry(now: Date, error?: string): void {
    const delay = Math.min(BASE_DELAY_MS * 2 ** this._attempts, MAX_DELAY_MS);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, 500);
  }
}
