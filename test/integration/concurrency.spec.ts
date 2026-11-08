import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { assertLedgerConsistent, httpCtx, setupDatabase, wagerCommand, type TestDb } from '../support/database';

let db: TestDb;
beforeAll(async () => {
  db = await setupDatabase();
});
afterAll(async () => {
  await db.close();
});

const openWallet = (amount: string) =>
  db.createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: 'BRL' } }, newId());

describe('concorrência (PostgreSQL real, paralelismo real)', () => {
  it('cenário obrigatório: 100.00, duas apostas de 80.00 simultâneas', async () => {
    const wallet = await openWallet('100.00');
    const results = await Promise.all([
      db.processWager.execute(wagerCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }), httpCtx()),
      db.processWager.execute(wagerCommand(wallet, { money: { amount: '80.00', currency: 'BRL' } }), httpCtx()),
    ]);

    const statuses = results.map((r): string => r.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode as string | undefined).toBe('INSUFFICIENT_FUNDS');

    const view = await db.queries.getWallet(wallet.id);
    expect(view.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    const debits = await db.sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id]);
    expect(debits[0]).toEqual({ n: 1 });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('a mesma aposta 50x em paralelo → um único débito, 49 replays idênticos', async () => {
    const wallet = await openWallet('1000.00');
    const command = wagerCommand(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const results = await Promise.all(Array.from({ length: 50 }, () => db.processWager.execute(command, httpCtx())));

    const original = results.filter((r) => !r.idempotentReplay);
    expect(original).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '975.00')).toBe(true);

    const view = await db.queries.getWallet(wallet.id);
    expect(view.balance.amount).toBe('975.00');
    expect(view.version).toBe(2);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('hot wallet: 40 apostas distintas de 10.00 sobre 100.00 → exatamente 10 aceitas, saldo zero', async () => {
    const wallet = await openWallet('100.00');
    const results = await Promise.all(Array.from({ length: 40 }, () => db.processWager.execute(wagerCommand(wallet), httpCtx())));
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    expect((await db.queries.getWallet(wallet.id)).balance.amount).toBe('0.00');
    await assertLedgerConsistent(db, wallet.id);
  });

  it('wallets distintas processadas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('50.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => db.processWager.execute(wagerCommand(w), httpCtx()))),
    );
    for (const w of wallets) {
      expect((await db.queries.getWallet(w.id)).balance.amount).toBe('0.00');
      await assertLedgerConsistent(db, w.id);
    }
  });
});
