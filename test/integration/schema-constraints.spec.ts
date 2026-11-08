import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { newId } from '../../src/domain/shared/id';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { httpCtx, setupDatabase, wagerCommand, type TestDb } from '../support/database';

/**
 * As garantias valem mesmo para quem contorna a aplicação (SQL direto):
 * schema, constraints e triggers são a última linha de defesa.
 */
let db: TestDb;
beforeAll(async () => {
  db = await setupDatabase();
});
afterAll(async () => {
  await db.close();
});

async function walletWithBet() {
  const wallet = await db.createWallet.execute({ playerId: newId(), initialBalance: { amount: '100.00', currency: 'BRL' } }, newId());
  const bet = await db.processWager.execute(wagerCommand(wallet), httpCtx());
  return { wallet, bet };
}

/** Executa numa transação isolada e devolve a mensagem de erro do PostgreSQL. */
async function pgError(statements: string[]): Promise<string> {
  try {
    await db.orm.em.fork().transactional(async (em) => {
      for (const s of statements) await em.execute(s);
    });
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error('expected statement to fail');
}

describe('schema: constraints e triggers', () => {
  it('migrations são reversíveis: up → down → up num banco descartável', async () => {
    const dbName = `migrations_check_${Date.now()}`;
    await db.orm.em.getConnection().execute(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:55432/wagering');
    url.pathname = `/${dbName}`;
    const scratch = await MikroORM.init(buildOrmConfig({ clientUrl: url.toString(), pool: { min: 0, max: 2 } }));
    const tables = async () =>
      (await scratch.em.fork().execute<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`))[0]!.n;
    try {
      await scratch.migrator.up();
      expect(await tables()).toBe(5);
      await scratch.migrator.down();
      expect(await tables()).toBe(0);
      await scratch.migrator.up();
      expect(await tables()).toBe(5);
    } finally {
      await scratch.close();
      await db.orm.em.getConnection().execute(`DROP DATABASE ${dbName}`);
    }
  });

  it('ledger é append-only: UPDATE é bloqueado', async () => {
    const { wallet } = await walletWithBet();
    expect(await pgError([`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = '${wallet.id}'`])).toContain('append-only');
  });

  it('ledger é append-only: DELETE e TRUNCATE são bloqueados', async () => {
    const { wallet } = await walletWithBet();
    expect(await pgError([`DELETE FROM wallet_ledger_entries WHERE wallet_id = '${wallet.id}'`])).toContain('append-only');
    expect(await pgError(['TRUNCATE wallet_ledger_entries CASCADE'])).toContain('append-only');
  });

  it('saldo negativo é impossível (CHECK)', async () => {
    const { wallet } = await walletWithBet();
    expect(await pgError([`UPDATE wallets SET balance = -1 WHERE id = '${wallet.id}'`])).toContain('check');
  });

  it('saldo alterado sem lançamento é barrado no COMMIT (constraint trigger adiada)', async () => {
    const { wallet } = await walletWithBet();
    expect(await pgError([`UPDATE wallets SET balance = 5000 WHERE id = '${wallet.id}'`])).toContain('out of sync with ledger');
  });

  it('transação terminal é imutável', async () => {
    const { bet } = await walletWithBet();
    expect(await pgError([`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = '${bet.transactionId}'`])).toContain(
      'terminal',
    );
  });

  it('dois lançamentos não podem partir da mesma versão da wallet', async () => {
    const { wallet, bet } = await walletWithBet();
    const msg = await pgError([
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES ('${newId()}', '${wallet.id}', '${bet.transactionId}', 'DEBIT', 1, 'BRL', 90, 89, 2, now())`,
    ]);
    expect(msg).toMatch(/ledger_wallet_(version|transaction)_uq/);
  });

  it('lançamento aritmeticamente inválido é rejeitado', async () => {
    const { wallet, bet } = await walletWithBet();
    expect(
      await pgError([
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         VALUES ('${newId()}', '${wallet.id}', '${bet.transactionId}', 'CREDIT', 10, 'BRL', 90, 999, 99, now())`,
      ]),
    ).toContain('ledger_balanced_ck');
  });

  it('uma wallet por player + moeda', async () => {
    const playerId = newId();
    await db.createWallet.execute({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, newId());
    await expect(db.createWallet.execute({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, newId())).rejects.toThrow(
      'already exists',
    );
    // mesma pessoa, outra moeda: permitido (modelo multi-moeda)
    await db.createWallet.execute({ playerId, initialBalance: { amount: '1.00', currency: 'USD' } }, newId());
  });

  it('a mesma referência não pode ser revertida duas vezes (índice único parcial)', async () => {
    const { wallet, bet } = await walletWithBet();
    const betExt = (await db.queries.getTransaction(bet.transactionId)).externalTransactionId;
    const refund = await db.processWager.execute(
      wagerCommand(wallet, { kind: 'REFUND', referenceExternalTransactionId: betExt }),
      httpCtx(),
    );
    expect(refund.status as string).toBe('PROCESSED');
    const rows = await db.sql<{ id: string }>(`SELECT id FROM wager_transactions WHERE id = ?`, [refund.transactionId]);
    expect(rows).toHaveLength(1);
    const msg = await pgError([
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
         kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, resulting_balance, correlation_id, created_at, processed_at)
       VALUES ('${newId()}', 'provider-a', 'dup-${newId()}', 'k-${newId()}', '${'0'.repeat(64)}', '${wallet.id}', '${wallet.playerId}', 'round-1', 'g',
         'ROLLBACK', 10, 'BRL', '${betExt}', '${bet.transactionId}', 'PROCESSED', 100, 'c', now(), now())`,
    ]);
    expect(msg).toContain('wager_tx_single_reversal_uq');
  });
});
