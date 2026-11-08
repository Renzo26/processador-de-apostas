import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxStore } from '../../application/ports/messaging';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { translateError } from './postgres-unit-of-work';

type Row = Record<string, unknown>;

export class PgOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(owner: string, limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    // Statement único (autocommit): o SELECT ... SKIP LOCKED escolhe linhas que
    // nenhum outro publisher está reivindicando neste instante, e o UPDATE grava
    // o lease. Linhas com lease vigente ficam de fora; lease vencido = dono morreu.
    const rows = await this.exec<Row[]>(
      `UPDATE outbox_messages o
          SET locked_until = ?::timestamptz + (? || ' milliseconds')::interval,
              locked_by    = ?
        WHERE o.id IN (
              SELECT id FROM outbox_messages
               WHERE published_at IS NULL
                 AND next_attempt_at <= ?
                 AND (locked_until IS NULL OR locked_until < ?)
               ORDER BY seq
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [now, String(leaseMs), owner, now, now, limit],
      'all',
    );
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map(toOutbox);
  }

  async release(owner: string, message: OutboxMessage): Promise<void> {
    if (message.publishedAt) {
      // published_at IS NULL: se outra instância (lease vencido) já marcou, não há o que fazer.
      await this.exec(
        `UPDATE outbox_messages SET published_at = ?, locked_until = NULL, locked_by = NULL, last_error = NULL
          WHERE id = ? AND published_at IS NULL`,
        [message.publishedAt, message.id],
        'run',
      );
      return;
    }
    await this.exec(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, last_error = ?, locked_until = NULL, locked_by = NULL
        WHERE id = ? AND published_at IS NULL AND locked_by = ?`,
      [message.attempts, message.nextAttemptAt, message.lastError ?? null, message.id, owner],
      'run',
    );
  }

  async stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await this.exec<Row[]>(
      `SELECT count(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (?::timestamptz - min(occurred_at))), 0)::float AS age
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
      'all',
    );
    return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Math.max(0, Number(row?.age ?? 0)) };
  }

  private async exec<T>(sql: string, params: unknown[], method: 'all' | 'run'): Promise<T> {
    try {
      return await this.orm.em.fork().execute<T & object>(sql, params, method);
    } catch (error) {
      throw translateError(error);
    }
  }
}

function toOutbox(row: Row): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: String(row.id),
    aggregateId: String(row.aggregate_id),
    eventType: String(row.event_type),
    payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    occurredAt: new Date(row.occurred_at as string),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at as string) : undefined,
    publishedAt: row.published_at ? new Date(row.published_at as string) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
  });
}
