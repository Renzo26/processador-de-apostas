import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import { InboxMessage as Inbox } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { ConcurrencyConflictError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';

type Row = Record<string, unknown>;

/** Executor SQL ligado ao EntityManager (e, portanto, à transação corrente). */
class Sql {
  constructor(private readonly em: EntityManager) {}

  async all<T extends Row>(query: string, params: unknown[] = []): Promise<T[]> {
    return this.em.execute<T[]>(query, params, 'all');
  }

  async one<T extends Row>(query: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.all<T>(query, params))[0];
  }

  async run(query: string, params: unknown[] = []): Promise<number> {
    const res = await this.em.execute<{ affectedRows: number }>(query, params, 'run');
    return res.affectedRows;
  }
}

const money = (amount: unknown, currency: unknown) => Money.rehydrate({ amount: String(amount), currency: String(currency).trim() });
const optDate = (v: unknown) => (v === null || v === undefined ? undefined : new Date(v as string));
const optStr = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

// ============================================================================ wallets

export class PgWalletRepository implements WalletRepository {
  private readonly sql: Sql;
  constructor(em: EntityManager) {
    this.sql = new Sql(em);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.sql.one('SELECT * FROM wallets WHERE id = ?', [id]);
    return row && toWallet(row);
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.sql.one('SELECT * FROM wallets WHERE id = ? FOR UPDATE', [id]);
    return row && toWallet(row);
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.sql.run(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toFixedAmount(), wallet.version, wallet.createdAt, wallet.updatedAt],
    );
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.sql.run(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
      [wallet.balance.toFixedAmount(), wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (affected !== 1) throw new ConcurrencyConflictError('wallets.version');
  }
}

function toWallet(row: Row): Wallet {
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency).trim(),
    balance: money(row.balance, row.currency),
    version: Number(row.version),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  });
}

// ============================================================================ transactions

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  private readonly sql: Sql;
  constructor(em: EntityManager) {
    this.sql = new Sql(em);
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one('SELECT * FROM wager_transactions WHERE id = ?', [id]);
    return row && toTransaction(row);
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one('SELECT * FROM wager_transactions WHERE provider_id = ? AND idempotency_key = ?', [
      providerId,
      idempotencyKey,
    ]);
    return row && toTransaction(row);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one('SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?', [
      providerId,
      externalTransactionId,
    ]);
    return row && toTransaction(row);
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const row = await this.sql.one(
      `SELECT 1 AS hit FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
        LIMIT 1`,
      [transactionId],
    );
    return row !== undefined;
  }

  async insert(tx: WagerTransaction, correlationId: string): Promise<void> {
    await this.sql.run(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, failure_code, resulting_balance, reference_attempts, next_reference_attempt_at,
         correlation_id, created_at, processed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toFixedAmount(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.resultingBalance?.toFixedAmount() ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        correlationId,
        tx.createdAt,
        tx.processedAt ?? null,
      ],
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    await this.sql.run(
      `UPDATE wager_transactions
          SET status = ?, reference_transaction_id = ?, failure_code = ?, resulting_balance = ?,
              reference_attempts = ?, next_reference_attempt_at = ?, processed_at = ?
        WHERE id = ?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.resultingBalance?.toFixedAmount() ?? null,
        tx.referenceAttempts,
        tx.nextReferenceAttemptAt ?? null,
        tx.processedAt ?? null,
        tx.id,
      ],
    );
  }

  async lockPendingReference(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one(
      `SELECT * FROM wager_transactions WHERE id = ? AND status = 'PENDING_REFERENCE' FOR UPDATE SKIP LOCKED`,
      [id],
    );
    return row && toTransaction(row);
  }

  async findDuePendingReference(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.sql.all(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
        ORDER BY next_reference_attempt_at
        LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: String(r.id), walletId: String(r.wallet_id) }));
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.sql.run(
      `UPDATE wager_transactions SET next_reference_attempt_at = ?
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_reference_attempt_at > ?`,
      [now, providerId, externalTransactionId, now],
    );
  }
}

function toTransaction(row: Row): WagerTransaction {
  const currency = String(row.currency).trim();
  return WagerTransaction.rehydrate({
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, currency),
    referenceExternalTransactionId: optStr(row.reference_external_transaction_id),
    referenceTransactionId: optStr(row.reference_transaction_id),
    status: row.status as WagerTransactionStatus,
    failureCode: optStr(row.failure_code) as FailureCode | undefined,
    resultingBalance: row.resulting_balance === null ? undefined : money(row.resulting_balance, currency),
    referenceAttempts: Number(row.reference_attempts),
    nextReferenceAttemptAt: optDate(row.next_reference_attempt_at),
    createdAt: new Date(row.created_at as string),
    processedAt: optDate(row.processed_at),
  });
}

// ============================================================================ ledger

export class PgLedgerRepository implements LedgerRepository {
  private readonly sql: Sql;
  constructor(em: EntityManager) {
    this.sql = new Sql(em);
  }

  async append(entry: WalletLedgerEntry, walletVersion: number): Promise<void> {
    await this.sql.run(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toFixedAmount(),
        entry.money.currency,
        entry.balanceBefore.toFixedAmount(),
        entry.balanceAfter.toFixedAmount(),
        walletVersion,
        entry.createdAt,
      ],
    );
  }

  async page(walletId: string, afterSeq: bigint | undefined, limit: number) {
    const rows = await this.sql.all(
      `SELECT * FROM wallet_ledger_entries
        WHERE wallet_id = ? AND seq > ?
        ORDER BY seq
        LIMIT ?`,
      [walletId, (afterSeq ?? 0n).toString(), limit + 1],
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      entries: pageRows.map(toLedgerEntry),
      lastSeq: last ? BigInt(String(last.seq)) : undefined,
      hasMore,
    };
  }

  async replayBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    // Soma feita no banco em NUMERIC (exato), não em JS.
    const row = await this.sql.one(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20, 2) AS balance,
              COUNT(*)::int AS entries
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    return { balance: money(row!.balance, currency), entries: Number(row!.entries) };
  }
}

function toLedgerEntry(row: Row): WalletLedgerEntry {
  const currency = String(row.currency).trim();
  return WalletLedgerEntry.rehydrate({
    id: String(row.id),
    walletId: String(row.wallet_id),
    transactionId: String(row.transaction_id),
    direction: row.direction as LedgerDirection,
    money: money(row.amount, currency),
    balanceBefore: money(row.balance_before, currency),
    balanceAfter: money(row.balance_after, currency),
    createdAt: new Date(row.created_at as string),
  });
}

// ============================================================================ inbox / outbox

export class PgInboxRepository implements InboxRepository {
  private readonly sql: Sql;
  constructor(em: EntityManager) {
    this.sql = new Sql(em);
  }

  async register(message: InboxMessage) {
    const inserted = await this.sql.run(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted === 1) return { inserted: true as const };

    const row = await this.sql.one('SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?', [
      message.consumerName,
      message.messageId,
    ]);
    return {
      inserted: false as const,
      existing: Inbox.rehydrate({
        messageId: String(row!.message_id),
        consumerName: String(row!.consumer_name),
        payloadHash: String(row!.payload_hash),
        receivedAt: new Date(row!.received_at as string),
        processedAt: optDate(row!.processed_at),
      }),
    };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.sql.run(
      'UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ? AND processed_at IS NULL',
      [message.processedAt, message.consumerName, message.messageId],
    );
  }
}

export class PgOutboxRepository implements OutboxRepository {
  private readonly sql: Sql;
  constructor(em: EntityManager) {
    this.sql = new Sql(em);
  }

  async add(messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) {
      await this.sql.run(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? m.occurredAt],
      );
    }
  }
}
