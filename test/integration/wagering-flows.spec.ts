import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import { noopMetrics, systemClock } from '../../src/application/ports/observability';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { PendingReferenceWorker } from '../../src/application/wagering/pending-reference-worker';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { newId } from '../../src/domain/shared/id';
import { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import { assertLedgerConsistent, httpCtx, setupDatabase, wagerCommand, type TestDb } from '../support/database';

let db: TestDb;
beforeAll(async () => {
  db = await setupDatabase({ retryPolicy: ReferenceRetryPolicy.create({ maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 100 }) });
});
afterAll(async () => {
  await db.close();
});

const openWallet = (amount = '100.00') =>
  db.createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: 'BRL' } }, newId());
const worker = () => new PendingReferenceWorker(db.uow, db.processWager, systemClock);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('fluxos de negócio (PostgreSQL real)', () => {
  it('replay devolve o resultado ORIGINAL, inclusive o saldo daquele momento', async () => {
    const wallet = await openWallet();
    const bet = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const first = await db.processWager.execute(bet, httpCtx());
    await db.processWager.execute(wagerCommand(wallet, { money: { amount: '50.00', currency: 'BRL' } }), httpCtx());

    const replay = await db.processWager.execute(bet, httpCtx());
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance?.amount).toBe('70.00'); // não o saldo atual (20.00)
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('20.00');
  });

  it('mesma Idempotency-Key com payload diferente → conflito, não replay', async () => {
    const wallet = await openWallet();
    const bet = wagerCommand(wallet);
    await db.processWager.execute(bet, httpCtx());
    await expect(db.processWager.execute({ ...bet, money: { amount: '11.00', currency: 'BRL' } }, httpCtx())).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('mesmo externalTransactionId com outra key → conflito', async () => {
    const wallet = await openWallet();
    const bet = wagerCommand(wallet);
    await db.processWager.execute(bet, httpCtx());
    await expect(db.processWager.execute({ ...bet, idempotencyKey: 'other-key' }, httpCtx())).rejects.toThrow(
      'externalTransactionId was already used',
    );
  });

  it('rejeição também é replayable (mesmo failureCode e saldo)', async () => {
    const wallet = await openWallet('5.00');
    const bet = wagerCommand(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    const first = await db.processWager.execute(bet, httpCtx());
    expect(first.failureCode as string).toBe('INSUFFICIENT_FUNDS');
    expect(await db.processWager.execute(bet, httpCtx())).toEqual({ ...first, idempotentReplay: true });
  });

  it('ROLLBACK antes da BET → PENDING_REFERENCE → worker aplica quando a BET chega', async () => {
    const wallet = await openWallet();
    const betExt = `bet-${newId()}`;
    const rollback = await db.processWager.execute(
      wagerCommand(wallet, { kind: 'ROLLBACK', money: { amount: '40.00', currency: 'BRL' }, referenceExternalTransactionId: betExt }),
      httpCtx(),
    );
    expect(rollback.status as string).toBe('PENDING_REFERENCE');

    await db.processWager.execute(wagerCommand(wallet, { externalTransactionId: betExt, money: { amount: '40.00', currency: 'BRL' } }), httpCtx());
    await worker().runOnce(); // a BET "acordou" o rollback: não precisa esperar o backoff

    const tx = await db.queries.getTransaction(rollback.transactionId);
    expect(tx.status as string).toBe('PROCESSED');
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
    await assertLedgerConsistent(db, wallet.id);
  });

  it('REFUND de referência que nunca chega → REJECTED com REFERENCE_NOT_FOUND após esgotar o limite', async () => {
    const wallet = await openWallet();
    const refund = await db.processWager.execute(
      wagerCommand(wallet, { kind: 'REFUND', referenceExternalTransactionId: `ghost-${newId()}` }),
      httpCtx(),
    );
    for (let i = 0; i < 5; i++) {
      await sleep(120);
      await worker().runOnce();
    }
    const tx = await db.queries.getTransaction(refund.transactionId);
    expect(tx.status as string).toBe('REJECTED');
    expect(tx.failureCode as string).toBe('REFERENCE_NOT_FOUND');
    const events = await db.sql<{ event_type: string }>(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq`, [
      refund.transactionId,
    ]);
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  it('REFUND e ROLLBACK concorrentes da mesma BET → só uma reversão é aplicada', async () => {
    const wallet = await openWallet();
    const betExt = `bet-${newId()}`;
    await db.processWager.execute(wagerCommand(wallet, { externalTransactionId: betExt, money: { amount: '60.00', currency: 'BRL' } }), httpCtx());
    const results = await Promise.all([
      db.processWager.execute(wagerCommand(wallet, { kind: 'REFUND', money: { amount: '60.00', currency: 'BRL' }, referenceExternalTransactionId: betExt }), httpCtx()),
      db.processWager.execute(wagerCommand(wallet, { kind: 'ROLLBACK', money: { amount: '60.00', currency: 'BRL' }, referenceExternalTransactionId: betExt }), httpCtx()),
      db.processWager.execute(wagerCommand(wallet, { kind: 'REFUND', money: { amount: '60.00', currency: 'BRL' }, referenceExternalTransactionId: betExt }), httpCtx()),
    ]);
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => (r.failureCode as string) === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(2);
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
    await assertLedgerConsistent(db, wallet.id);
  });

  it('ROLLBACK de WIN que negativaria o saldo → REVERSAL_INSUFFICIENT_FUNDS, auditável', async () => {
    const wallet = await openWallet('0.00');
    const winExt = `win-${newId()}`;
    await db.processWager.execute(wagerCommand(wallet, { kind: 'WIN', externalTransactionId: winExt, money: { amount: '50.00', currency: 'BRL' } }), httpCtx());
    await db.processWager.execute(wagerCommand(wallet, { money: { amount: '45.00', currency: 'BRL' } }), httpCtx());
    const rb = await db.processWager.execute(
      wagerCommand(wallet, { kind: 'ROLLBACK', money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: winExt }),
      httpCtx(),
    );
    expect(rb.failureCode as string).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await db.queries.getTransaction(rb.transactionId)).status as string).toBe('REJECTED');
    await assertLedgerConsistent(db, wallet.id);
  });

  it('atomicidade: falha no último passo (outbox) desfaz inbox, transação, saldo e ledger', async () => {
    const wallet = await openWallet();
    const failingOutbox: UnitOfWork = {
      read: (w) => db.uow.read(w),
      run: (work) =>
        db.uow.run((repos) =>
          work({ ...repos, outbox: { add: async () => Promise.reject(new Error('crash before commit')) } }),
        ),
    };
    const process = new ProcessWagerTransaction(failingOutbox, new WagerSettlement(ReferenceRetryPolicy.create()), systemClock, noopMetrics);
    const cmd = wagerCommand(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const messageId = `msg-${newId()}`;

    await expect(
      process.execute(cmd, { correlationId: newId(), source: 'sqs', inbox: { consumerName: 'test', messageId } }),
    ).rejects.toThrow('crash before commit');

    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect(await db.sql(`SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?`, [cmd.externalTransactionId])).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM inbox_messages WHERE message_id = ?`, [messageId])).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toHaveLength(0);

    // E a reentrega posterior (com o caminho saudável) processa normalmente.
    const ok = await db.processWager.execute(cmd, { correlationId: newId(), source: 'sqs', inbox: { consumerName: 'test', messageId } });
    expect(ok.status as string).toBe('PROCESSED');
    await assertLedgerConsistent(db, wallet.id);
  });

  it('ledger paginado com cursor opaco e estável', async () => {
    const wallet = await openWallet('100.00');
    for (let i = 0; i < 4; i++) await db.processWager.execute(wagerCommand(wallet), httpCtx());
    const p1 = await db.queries.getLedger(wallet.id, undefined, 2);
    // nova entrada entre páginas não altera o que já foi visto nem pula itens
    await db.processWager.execute(wagerCommand(wallet), httpCtx());
    const p2 = await db.queries.getLedger(wallet.id, p1.nextCursor!, 2);
    const p3 = await db.queries.getLedger(wallet.id, p2.nextCursor!, 2);
    const all = [...p1.items, ...p2.items, ...p3.items];
    expect(all).toHaveLength(6); // abertura + 5 apostas
    expect(new Set(all.map((e) => e.id)).size).toBe(6);
    expect(p3.nextCursor).toBeNull();
  });
});
