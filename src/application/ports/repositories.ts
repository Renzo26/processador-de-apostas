import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/shared/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: serializa todas as operações sobre a mesma wallet (e só sobre ela). */
  lockById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** UPDATE condicionado à versão anterior — defesa em profundidade além do lock. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND/ROLLBACK PROCESSED apontando para a transação? */
  isReversed(transactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction, correlationId: string): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
  /** Lock com SKIP LOCKED: vários workers dividem o trabalho sem bloquear uns aos outros. */
  lockPendingReference(id: string): Promise<WagerTransaction | undefined>;
  findDuePendingReference(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  /** Antecipa o reprocessamento das transações que aguardavam esta referência. */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry, walletVersion: number): Promise<void>;
  page(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<{ entries: WalletLedgerEntry[]; lastSeq: bigint | undefined; hasMore: boolean }>;
  /** Saldo reconstruído: soma com sinal de todos os lançamentos. */
  replayBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
}

export interface InboxRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING. Devolve a mensagem existente quando já
   * registrada (duplicata). Se outra transação concorrente estiver inserindo a
   * mesma chave, o PostgreSQL bloqueia até ela terminar.
   */
  register(message: InboxMessage): Promise<{ inserted: true } | { inserted: false; existing: InboxMessage }>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(messages: OutboxMessage[]): Promise<void>;
}

/** Repositórios ligados a UMA transação SQL. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa única transação SQL. Tudo o que for gravado pelos
   * repositórios recebidos é confirmado junto, ou nada é.
   */
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
  /** Leitura fora de transação explícita. */
  read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
