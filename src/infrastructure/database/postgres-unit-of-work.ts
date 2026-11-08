import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../../application/errors';
import type { TransactionalRepositories, UnitOfWork } from '../../application/ports/repositories';
import {
  PgInboxRepository,
  PgLedgerRepository,
  PgOutboxRepository,
  PgWagerTransactionRepository,
  PgWalletRepository,
} from './postgres-repositories';

/** Constraints cuja violação significa "perdi uma corrida" — a nova tentativa cai no replay. */
const RACE_CONSTRAINTS = new Set([
  'wager_tx_idempotency_uq',
  'wager_tx_external_uq',
  'wager_tx_single_reversal_uq',
  'ledger_wallet_version_uq',
  'inbox_messages_pkey',
]);

/** SQLSTATEs transitórios: reenviar é seguro. */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', '08003', '08006', '08001', '08004', // connection exceptions
]);

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export interface PgUnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

/**
 * Unit of Work sobre `em.transactional()` do MikroORM (READ COMMITTED).
 *
 * READ COMMITTED + `SELECT ... FOR UPDATE` na wallet é suficiente: toda decisão
 * financeira acontece com o lock da linha da wallet, e cada statement enxerga o
 * que os concorrentes já commitaram. lock_timeout evita espera indefinida numa
 * hot wallet — o timeout vira erro transitório (retry com backoff no chamador).
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: PgUnitOfWorkOptions = { lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 },
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute(`SET LOCAL lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`);
          await em.execute(`SET LOCAL statement_timeout = '${Math.trunc(this.options.statementTimeoutMs)}ms'`);
          return work(repositories(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateError(error);
    }
  }

  async read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await work(repositories(this.orm.em.fork()));
    } catch (error) {
      throw translateError(error);
    }
  }
}

function repositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new PgWalletRepository(em),
    transactions: new PgWagerTransactionRepository(em),
    ledger: new PgLedgerRepository(em),
    inbox: new PgInboxRepository(em),
    outbox: new PgOutboxRepository(em),
  };
}

/** Converte erros do driver em erros da aplicação (sem vazar detalhes do PostgreSQL). */
export function translateError(error: unknown): unknown {
  if (error instanceof ConcurrencyConflictError || error instanceof TransientInfrastructureError) return error;

  const pg = findPgError(error);
  if (pg?.code === '23505' && pg.constraint && RACE_CONSTRAINTS.has(pg.constraint)) {
    return new ConcurrencyConflictError(pg.constraint, error);
  }
  if (pg?.code && TRANSIENT_SQLSTATES.has(pg.code)) {
    return new TransientInfrastructureError(`Database transient failure (${pg.code})`, error);
  }
  if (pg?.code && TRANSIENT_NODE_CODES.has(pg.code)) {
    return new TransientInfrastructureError(`Database unreachable (${pg.code})`, error);
  }
  if (error instanceof Error && /connect|Connection terminated|timeout/i.test(error.message) && !pg?.constraint) {
    return new TransientInfrastructureError('Database unavailable', error);
  }
  return error;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function findPgError(error: unknown): PgErrorLike | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as PgErrorLike & { cause?: unknown };
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return undefined;
}
