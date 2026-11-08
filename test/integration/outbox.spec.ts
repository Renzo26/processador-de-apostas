import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { OutboxRelay } from '../../src/application/messaging/outbox-relay';
import type { EventPublisher } from '../../src/application/ports/messaging';
import { noopMetrics, systemClock } from '../../src/application/ports/observability';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { newId } from '../../src/domain/shared/id';
import { PgOutboxStore } from '../../src/infrastructure/database/pg-outbox-store';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { httpCtx, setupDatabase, wagerCommand, type TestDb } from '../support/database';
import { createTestQueues, drain, sqsClient } from '../support/sqs';

let db: TestDb;
let store: PgOutboxStore;
beforeAll(async () => {
  db = await setupDatabase();
  store = new PgOutboxStore(db.orm);
  await drainOutbox(); // começa sem backlog de outros testes
});
afterAll(async () => {
  await db.close();
});

/** Publisher em memória que registra cada publicação (para contar duplicatas). */
class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  constructor(private readonly delayMs = 0) {}
  async publish(messages: OutboxMessage[]) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const result = new Map<string, { ok: true }>();
    for (const m of messages) {
      this.published.push(m.id);
      result.set(m.id, { ok: true });
    }
    return result;
  }
}

const relay = (publisher: EventPublisher, owner: string, leaseMs = 30_000) =>
  new OutboxRelay(store, publisher, systemClock, noopMetrics, { owner, batchSize: 20, leaseMs });

async function drainOutbox() {
  const sink = relay(new RecordingPublisher(), 'drain');
  while ((await sink.runOnce()) > 0);
}

async function produceEvents(bets: number): Promise<string[]> {
  const wallet = await db.createWallet.execute({ playerId: newId(), initialBalance: { amount: '1000.00', currency: 'BRL' } }, newId());
  for (let i = 0; i < bets; i++) await db.processWager.execute(wagerCommand(wallet), httpCtx());
  const rows = await db.sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY seq`);
  return rows.map((r) => r.id);
}

describe('Transactional Outbox', () => {
  it('dois publishers concorrentes sobre a mesma outbox: cada evento publicado exatamente uma vez', async () => {
    const ids = await produceEvents(30); // 61 eventos (abertura + 30 × Processed/BalanceChanged)
    const a = new RecordingPublisher(5);
    const b = new RecordingPublisher(5);
    const relayA = relay(a, 'publisher-a');
    const relayB = relay(b, 'publisher-b');

    for (;;) {
      const [na, nb] = await Promise.all([relayA.runOnce(), relayB.runOnce()]);
      if (na + nb === 0) break;
    }

    const all = [...a.published, ...b.published].filter((id) => ids.includes(id));
    expect(all.sort()).toEqual([...ids].sort());
    expect(new Set(all).size).toBe(all.length); // nenhuma duplicata
    expect(a.published.length).toBeGreaterThan(0);
    expect(b.published.length).toBeGreaterThan(0);
  });

  it('commit confirmado, processo morre antes de publicar → outra instância assume após o lease', async () => {
    const ids = await produceEvents(2);
    // Instância A reivindica e "morre" (não publica nem libera).
    const claimed = await store.claim('dying-instance', 50, 300, new Date());
    expect(claimed.map((m) => m.id)).toEqual(expect.arrayContaining(ids));

    // Enquanto o lease vale, ninguém mais pega.
    const b = new RecordingPublisher();
    expect(await relay(b, 'instance-b').runOnce()).toBe(0);

    await new Promise((r) => setTimeout(r, 400)); // lease expira
    await relay(b, 'instance-b').runOnce();
    expect(b.published).toEqual(expect.arrayContaining(ids));
    const pending = await db.sql(`SELECT id FROM outbox_messages WHERE id IN (?) AND published_at IS NULL`, [ids]);
    expect(pending).toHaveLength(0);
  });

  it('falha de publicação → backoff exponencial, sem perder o evento', async () => {
    const ids = await produceEvents(1);
    const failing: EventPublisher = {
      publish: async (messages) => new Map(messages.map((m) => [m.id, { ok: false as const, error: 'broker down' }])),
    };
    await relay(failing, 'p').runOnce();
    const rows = await db.sql<{ attempts: number; last_error: string; due_in_ms: number }>(
      `SELECT attempts, last_error, EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000 AS due_in_ms
         FROM outbox_messages WHERE id IN (?)`,
      [ids],
    );
    expect(rows.every((r) => r.attempts === 1 && r.last_error === 'broker down' && Number(r.due_in_ms) > 0)).toBe(true);

    // não é republicado antes do horário…
    const early = new RecordingPublisher();
    await relay(early, 'p').runOnce();
    expect(early.published.filter((id) => ids.includes(id))).toHaveLength(0);
    // …e é publicado depois.
    await new Promise((r) => setTimeout(r, 1100));
    const later = new RecordingPublisher();
    await relay(later, 'p').runOnce();
    expect(later.published).toEqual(expect.arrayContaining(ids));
  });

  it('publicação real no SQS FIFO: republicação do mesmo evento é segura (mesmo eventId)', async () => {
    const sqs: SQSClient = sqsClient();
    const q = await createTestQueues(sqs);
    try {
      await drainOutbox();
      const ids = await produceEvents(1);
      const real = new SqsEventPublisher(sqs, q.queues, q.eventsName);
      // Grava as mensagens publicadas para republicá-las em seguida.
      let sent: OutboxMessage[] = [];
      const capturing: EventPublisher = {
        publish: async (messages) => {
          sent = messages;
          return real.publish(messages);
        },
      };
      await relay(capturing, 'real').runOnce();

      // Duplicação at-least-once: o relay morreu depois de publicar e outra instância publica de novo.
      const again = await real.publish(sent.filter((m) => ids.includes(m.id)));
      expect([...again.values()].every((r) => r.ok)).toBe(true);

      const received = (await drain(sqs, q.eventsUrl, 2)).map((m) => ({
        eventId: (JSON.parse(m.Body!) as { eventId: string }).eventId,
        type: m.MessageAttributes?.eventType?.StringValue,
      }));
      const ours = received.filter((r) => ids.includes(r.eventId));
      // Mesmo eventId → o SQS FIFO descarta a duplicata (MessageDeduplicationId); cada evento chega uma vez.
      expect(ours.map((r) => r.eventId).sort()).toEqual([...ids].sort());
      // abertura da wallet (WalletBalanceChanged) + BET (Processed + WalletBalanceChanged)
      expect(ours.map((r) => r.type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
    } finally {
      await q.cleanup();
      sqs.destroy();
    }
  });
});
