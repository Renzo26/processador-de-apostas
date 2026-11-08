import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { noopMetrics, systemClock } from '../../src/application/ports/observability';
import { ProcessWagerTransaction, type WagerTransactionCommand } from '../../src/application/wagering/process-wager-transaction';
import { CreateWallet, ReconcileWallet, WalletQueries } from '../../src/application/wallet/wallet-use-cases';
import { newId } from '../../src/domain/shared/id';
import { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { PgUnitOfWork } from '../../src/infrastructure/database/postgres-unit-of-work';

const BASE_URL = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:55432/wagering';
const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'wagering_test';

/**
 * Banco EXCLUSIVO dos testes (`wagering_test`), no mesmo PostgreSQL do compose.
 * Sem isso, instâncias da aplicação rodando em paralelo (docker compose --profile app)
 * consumiriam a mesma outbox/fila e interfeririam nos testes.
 * Também vale para os processos do e2e, que herdam process.env.DATABASE_URL.
 */
export const TEST_DATABASE_URL = (() => {
  const url = new URL(BASE_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
})();
process.env.DATABASE_URL = TEST_DATABASE_URL;

let ensured: Promise<void> | undefined;
async function ensureTestDatabase(): Promise<void> {
  ensured ??= (async () => {
    const admin = await MikroORM.init(buildOrmConfig({ clientUrl: BASE_URL, pool: { min: 0, max: 1 } }));
    try {
      const rows = await admin.em.fork().execute<{ n: number }[]>('SELECT count(*)::int AS n FROM pg_database WHERE datname = ?', [TEST_DB]);
      if (rows[0]!.n === 0) {
        await admin.em.getConnection().execute(`CREATE DATABASE "${TEST_DB}"`).catch((error: { code?: string }) => {
          if (error.code !== '42P04') throw error; // criado em paralelo por outro arquivo de teste
        });
      }
    } finally {
      await admin.close();
    }
  })();
  return ensured;
}

/**
 * Infra real para testes de integração (PostgreSQL em container).
 * Isolamento por dados: cada teste cria wallets/ids próprios — o ledger é
 * append-only e não pode ser truncado, então não há limpeza entre testes.
 */
export async function setupDatabase(opts: { retryPolicy?: ReferenceRetryPolicy } = {}) {
  await ensureTestDatabase();
  const orm = await MikroORM.init(buildOrmConfig({ clientUrl: TEST_DATABASE_URL, pool: { min: 1, max: 30 } }));
  await orm.migrator.up();
  const uow = new PgUnitOfWork(orm);
  const settlement = new WagerSettlement(opts.retryPolicy ?? ReferenceRetryPolicy.create());
  const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
    orm.em.fork().execute<T[]>(query, params, 'all');

  return {
    orm,
    uow,
    sql,
    processWager: new ProcessWagerTransaction(uow, settlement, systemClock, noopMetrics),
    createWallet: new CreateWallet(uow, systemClock),
    queries: new WalletQueries(uow),
    reconcile: new ReconcileWallet(uow, noopMetrics, () => {}),
    close: () => orm.close(),
  };
}

export type TestDb = Awaited<ReturnType<typeof setupDatabase>>;

export function wagerCommand(
  wallet: { id: string; playerId: string },
  overrides: Partial<WagerTransactionCommand> = {},
): WagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${newId()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export const httpCtx = () => ({ correlationId: newId(), source: 'http' as const });

/** Invariante final: saldo materializado == saldo reconstruído pelo ledger. */
export async function assertLedgerConsistent(db: TestDb, walletId: string): Promise<void> {
  const view = await db.reconcile.execute(walletId);
  if (!view.consistent) {
    throw new Error(`Wallet ${walletId} inconsistent: stored ${view.storedBalance.amount} vs ledger ${view.calculatedBalance.amount}`);
  }
}
