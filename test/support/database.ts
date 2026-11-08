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

/**
 * Infra real para testes de integração (PostgreSQL em container).
 * Isolamento por dados: cada teste cria wallets/ids próprios — o ledger é
 * append-only e não pode ser truncado, então não há limpeza entre testes.
 */
export async function setupDatabase(opts: { retryPolicy?: ReferenceRetryPolicy } = {}) {
  const orm = await MikroORM.init(buildOrmConfig({ pool: { min: 1, max: 30 } }));
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
