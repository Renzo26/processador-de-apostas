import { newId } from '../shared/id';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** Contexto de rastreabilidade propagado da entrada (HTTP/SQS) até os eventos. */
export interface EventContext {
  correlationId: string;
  causationId?: string | undefined;
  at: Date;
}

export interface IntegrationEventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Envelope de evento de integração. `eventType` e `version` ficam no tipo
 * (subclasse), nunca em string solta no call site. `data` é JSON puro
 * (Money vira MoneyProps), para o payload ser estável e versionável.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze({ ...props.data });
  }

  protected static baseProps<T>(aggregateId: string, data: T, ctx: EventContext): IntegrationEventProps<T> {
    return {
      eventId: newId(ctx.at.getTime()),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.at,
      data,
    };
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
