import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { setupDatabase, wagerCommand, type TestDb } from '../support/database';
import { http, spawnInstance, stopInstance, type Instance } from '../support/instances';
import { createTestQueues, queueDepth, sendWagerMessage, sqsClient, waitFor } from '../support/sqs';

/**
 * Testes com PROCESSOS reais da aplicação (≥ 3 instâncias), PostgreSQL e
 * LocalStack reais. Nenhum mock: cada instância tem seu próprio pool,
 * consumer SQS, relay de outbox e worker de referências.
 */
let db: TestDb;
let sqs: SQSClient;
let q: Awaited<ReturnType<typeof createTestQueues>>;
let instances: Instance[] = [];
const BASE_PORT = 41_000 + Math.floor(Math.random() * 1000);

const envFor = () => ({
  SQS_QUEUE_NAME: q.queueName,
  SQS_DLQ_NAME: q.dlqName,
  SQS_EVENTS_QUEUE_NAME: q.eventsName,
  SQS_MAX_RECEIVE_COUNT: '5',
});

beforeAll(async () => {
  db = await setupDatabase();
  sqs = sqsClient();
  q = await createTestQueues(sqs, { visibilityTimeout: 2, maxReceiveCount: 5 });
  instances = await Promise.all([0, 1, 2].map((i) => spawnInstance(`instance-${i}`, BASE_PORT + i, envFor())));
});

afterAll(async () => {
  await Promise.all(instances.map((i) => stopInstance(i)));
  await q.cleanup();
  sqs.destroy();
  await db.close();
});

async function createWallet(amount: string) {
  const res = await http<{ id: string; playerId: string }>(instances[0]!.url, 'POST', '/wallets', {
    playerId: newId(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(res.status).toBe(201);
  return res.body;
}

function submit(instance: Instance, cmd: ReturnType<typeof wagerCommand>) {
  const { idempotencyKey, ...body } = cmd;
  return http<{ status: string; failureCode?: string; idempotentReplay: boolean; transactionId: string }>(
    instance.url,
    'POST',
    '/wagering/transactions',
    body,
    { 'Idempotency-Key': idempotencyKey },
  );
}

async function reconcile(walletId: string) {
  const res = await http<{ consistent: boolean; storedBalance: { amount: string } }>(instances[0]!.url, 'POST', `/wallets/${walletId}/reconciliation`);
  expect(res.body.consistent).toBe(true);
  return res.body;
}

describe('3 instâncias simultâneas (processos reais)', () => {
  it('hot wallet: 60 apostas de 10.00 sobre 300.00 distribuídas entre 3 instâncias → exatamente 30 aceitas', async () => {
    const wallet = await createWallet('300.00');
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => submit(instances[i % 3]!, wagerCommand(wallet))),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(30);
    expect(responses.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    expect((await reconcile(wallet.id)).storedBalance.amount).toBe('0.00');
  });

  it('a mesma aposta 50x em paralelo, espalhada nas 3 instâncias → um único débito', async () => {
    const wallet = await createWallet('100.00');
    const cmd = wagerCommand(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(instances[i % 3]!, cmd)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200 && r.body.idempotentReplay)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await reconcile(wallet.id)).storedBalance.amount).toBe('75.00');
  });

  it('SQS: mensagens consumidas pelas 3 instâncias, inclusive duplicadas, sem efeito duplicado', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet('100.00')));
    for (const w of wallets) {
      for (let i = 0; i < 5; i++) {
        const cmd = wagerCommand(w);
        const messageId = await sendWagerMessage(sqs, q.queueUrl, cmd);
        if (i % 2 === 0) await sendWagerMessage(sqs, q.queueUrl, cmd, { messageId }); // redelivery
      }
    }
    await waitFor(async () => (await queueDepth(sqs, q.queueUrl)) === 0, 30_000);
    for (const w of wallets) expect((await reconcile(w.id)).storedBalance.amount).toBe('50.00');
  });

  it('outbox: todos os eventos publicados pelas instâncias concorrentes', async () => {
    await waitFor(async () => {
      const rows = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
      return rows[0]!.n === 0;
    }, 20_000);
  });
});

describe('falhas de processo', () => {
  it('processo morto (SIGKILL) depois do commit e antes do ack → outra instância conclui sem duplicar', async () => {
    const crashQ = await createTestQueues(sqs, { visibilityTimeout: 2, maxReceiveCount: 5 });
    const env = { SQS_QUEUE_NAME: crashQ.queueName, SQS_DLQ_NAME: crashQ.dlqName, SQS_EVENTS_QUEUE_NAME: crashQ.eventsName };
    const wallet = await createWallet('100.00');
    const cmd = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });

    const doomed = await spawnInstance('doomed', BASE_PORT + 10, { ...env, FAULT_INJECTION: 'crash-before-ack' });
    await sendWagerMessage(sqs, crashQ.queueUrl, cmd);
    await doomed.proc.exited;
    expect(doomed.proc.signalCode).toBe('SIGKILL');

    // O commit aconteceu: o débito está lá, mas a mensagem continua na fila (sem ack).
    expect((await reconcile(wallet.id)).storedBalance.amount).toBe('70.00');
    expect(await queueDepth(sqs, crashQ.queueUrl)).toBe(1);

    const survivor = await spawnInstance('survivor', BASE_PORT + 11, env);
    try {
      await waitFor(async () => (await queueDepth(sqs, crashQ.queueUrl)) === 0, 20_000);
      const res = await http<{ status: string }>(
        survivor.url,
        'GET',
        `/providers/${cmd.providerId}/wagering/transactions/${cmd.externalTransactionId}`,
      );
      expect(res.body.status).toBe('PROCESSED');
      expect((await reconcile(wallet.id)).storedBalance.amount).toBe('70.00');
      const debits = await db.sql(`SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id]);
      expect(debits).toHaveLength(1);
    } finally {
      await stopInstance(survivor);
      await crashQ.cleanup();
    }
  });

  it('SIGTERM: encerramento gracioso (para consumer/workers, fecha o pool) com exit code 0', async () => {
    const instance = await spawnInstance('graceful', BASE_PORT + 20, { ...envFor(), LOG_LEVEL: 'info' });
    const startedAt = Date.now();
    await stopInstance(instance, 'SIGTERM');
    expect(instance.proc.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    const logs = instance.logs();
    for (const event of ['app.stopping', 'sqs.consumer.stopped', 'worker.stopped', 'app.stopped']) {
      expect(logs).toContain(`"msg":"${event}"`);
    }
  });

  it('reinício sob carga: instância morta com SIGKILL e reiniciada → consistência final comprovada', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet('200.00')));
    const victim = instances[2]!;

    const load = Promise.allSettled(
      Array.from({ length: 80 }, (_, i) => submit(instances[i % 3]!, wagerCommand(wallets[i % 4]!))),
    );
    await new Promise((r) => setTimeout(r, 50));
    await stopInstance(victim, 'SIGKILL');
    await load; // requisições na instância morta falham (sem resposta) — o cliente reenviaria

    instances[2] = await spawnInstance('instance-2-restarted', BASE_PORT + 2, envFor());
    for (const w of wallets) {
      const r = await reconcile(w.id);
      expect(Number(r.storedBalance.amount)).toBeGreaterThanOrEqual(0);
    }
    // Nenhuma transação ficou "pela metade": toda PROCESSED de BET tem exatamente um lançamento.
    const orphans = await db.sql(
      `SELECT t.id FROM wager_transactions t
         LEFT JOIN wallet_ledger_entries l ON l.transaction_id = t.id
        WHERE t.wallet_id IN (?) AND t.kind = 'BET' AND t.status = 'PROCESSED' AND l.id IS NULL`,
      [wallets.map((w) => w.id)],
    );
    expect(orphans).toHaveLength(0);
  });
});
