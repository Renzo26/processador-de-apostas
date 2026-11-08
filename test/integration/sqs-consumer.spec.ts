import { DeleteMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import { noopMetrics } from '../../src/application/ports/observability';
import type { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { newId } from '../../src/domain/shared/id';
import { WagerTransactionsConsumer } from '../../src/interfaces/sqs/wager-transactions.consumer';
import { assertLedgerConsistent, setupDatabase, wagerCommand, type TestDb } from '../support/database';
import { createTestQueues, drain, queueDepth, sendWagerMessage, sqsClient } from '../support/sqs';

let db: TestDb;
let sqs: SQSClient;
let q: Awaited<ReturnType<typeof createTestQueues>>;

beforeAll(async () => {
  db = await setupDatabase();
  sqs = sqsClient();
});
afterAll(async () => {
  await db.close();
  sqs.destroy();
});
afterEach(async () => {
  await q?.cleanup();
});

function consumer(process: ProcessWagerTransaction = db.processWager, client: SQSClient = sqs, maxReceiveCount = 3) {
  return new WagerTransactionsConsumer(client, q.queues, process, noopMetrics, {
    queueName: q.queueName,
    dlqName: q.dlqName,
    maxReceiveCount,
    concurrency: 10,
    waitTimeSeconds: 1,
    maxBackoffSeconds: 1,
  });
}

const openWallet = (amount = '100.00') =>
  db.createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: 'BRL' } }, newId());

async function pollUntil(c: WagerTransactionsConsumer, expected: number, timeoutMs = 15_000) {
  const all: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (all.length < expected && Date.now() < deadline) all.push(...(await c.pollOnce(1)));
  return all;
}

describe('SQS consumer (LocalStack real)', () => {
  it('processa e faz ack após o commit; reutiliza o caso de uso do HTTP', async () => {
    q = await createTestQueues(sqs);
    const wallet = await openWallet();
    const cmd = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    await sendWagerMessage(sqs, q.queueUrl, cmd);

    expect(await pollUntil(consumer(), 1)).toEqual(['acked']);
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('70.00');
    expect(await queueDepth(sqs, q.queueUrl)).toBe(0);
  });

  it('inbox: a mesma mensagem entregue de novo (redelivery) não duplica o efeito', async () => {
    q = await createTestQueues(sqs);
    const wallet = await openWallet();
    const cmd = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const messageId = `msg-${newId()}`;
    // mesmo messageId de negócio, dedup do SQS diferente → o broker entrega as duas
    await sendWagerMessage(sqs, q.queueUrl, cmd, { messageId });
    await sendWagerMessage(sqs, q.queueUrl, cmd, { messageId });

    expect(await pollUntil(consumer(), 2)).toEqual(['acked', 'acked']);
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('70.00');
    const inbox = await db.sql(`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ?`, [messageId]);
    expect(inbox[0]).toEqual({ n: 1 });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('worker morre depois do commit e antes do ack → redelivery vira replay, um único débito', async () => {
    q = await createTestQueues(sqs, { visibilityTimeout: 1 });
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } }));

    // Cliente SQS cujo DeleteMessage "morre": o commit acontece, o ack nunca chega.
    const dying = new Proxy(sqs, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return (cmd: unknown, ...rest: unknown[]) => {
            if (cmd instanceof DeleteMessageCommand) return Promise.reject(new Error('process killed before ack'));
            return (target.send as (...a: unknown[]) => unknown).call(target, cmd, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await consumer(db.processWager, dying).pollOnce(1).catch(() => {});
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('70.00');

    // Outra instância recebe a mesma mensagem quando a visibilidade expira.
    const dispositions = await pollUntil(consumer(), 1);
    expect(dispositions).toEqual(['acked']);
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('70.00');
    const debits = await db.sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id]);
    expect(debits[0]).toEqual({ n: 1 });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('erro transitório → retry com backoff; quando o banco volta, processa', async () => {
    q = await createTestQueues(sqs);
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerCommand(wallet, { money: { amount: '10.00', currency: 'BRL' } }));

    let failuresLeft = 1;
    const flaky = {
      execute: (...args: Parameters<ProcessWagerTransaction['execute']>) => {
        if (failuresLeft-- > 0) return Promise.reject(new TransientInfrastructureError('database unavailable'));
        return db.processWager.execute(...args);
      },
    } as unknown as ProcessWagerTransaction;

    const c = consumer(flaky);
    expect(await c.pollOnce(1)).toEqual(['retry_scheduled']);
    expect(await pollUntil(c, 1)).toEqual(['acked']);
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('90.00');
  });

  it('erro transitório persistente → DLQ ao atingir o limite de tentativas', async () => {
    q = await createTestQueues(sqs, { maxReceiveCount: 5 });
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerCommand(wallet));
    const alwaysDown = { execute: () => Promise.reject(new TransientInfrastructureError('down')) } as unknown as ProcessWagerTransaction;

    const dispositions = await pollUntil(consumer(alwaysDown, sqs, 2), 2, 20_000);
    expect(dispositions).toEqual(['retry_scheduled', 'dead_lettered']);

    const dead = await drain(sqs, q.dlqUrl);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.deadLetterReason?.StringValue).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
  });

  it('mensagem malformada é permanente → DLQ direto, sem retries', async () => {
    q = await createTestQueues(sqs);
    await sqs.send(new SendMessageCommand({ QueueUrl: q.queueUrl, MessageBody: '{"type":"Oops"}', MessageGroupId: 'g', MessageDeduplicationId: newId() }));
    expect(await pollUntil(consumer(), 1)).toEqual(['dead_lettered']);
    const dead = await drain(sqs, q.dlqUrl);
    expect(dead[0]!.MessageAttributes?.deadLetterReason?.StringValue).toBe('INVALID_MESSAGE');
  });

  it('OPENING pela fila é rejeitado como payload inválido', async () => {
    q = await createTestQueues(sqs);
    const wallet = await openWallet();
    await sendWagerMessage(sqs, q.queueUrl, wagerCommand(wallet, { kind: 'OPENING' }));
    expect(await pollUntil(consumer(), 1)).toEqual(['dead_lettered']);
  });

  it('rejeição de negócio é terminal: ack, sem retry', async () => {
    q = await createTestQueues(sqs);
    const wallet = await openWallet('5.00');
    await sendWagerMessage(sqs, q.queueUrl, wagerCommand(wallet, { money: { amount: '50.00', currency: 'BRL' } }));
    expect(await pollUntil(consumer(), 1)).toEqual(['acked']);
    expect(await queueDepth(sqs, q.queueUrl)).toBe(0);
  });

  it('SIGTERM: stop() conclui o que está em andamento e encerra o loop', async () => {
    q = await createTestQueues(sqs);
    const wallet = await openWallet();
    for (let i = 0; i < 5; i++) await sendWagerMessage(sqs, q.queueUrl, wagerCommand(wallet));
    const c = consumer();
    c.start();
    await new Promise((r) => setTimeout(r, 1500));
    await c.stop();
    // nada ficou "meio processado": saldo e ledger consistentes, e o que não foi processado continua na fila
    await assertLedgerConsistent(db, wallet.id);
    const processed = Number((await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [wallet.id]))[0]!.n);
    expect(processed + (await queueDepth(sqs, q.queueUrl))).toBe(5);
  });
});
