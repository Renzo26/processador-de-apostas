import { WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { DomainError } from '../../domain/shared/domain-error';
import { newId } from '../../domain/shared/id';
import { Money, type MoneyProps } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { NotFoundError, ValidationError, WalletAlreadyExistsError } from '../errors';
import type { Clock, Metrics } from '../ports/observability';
import type { UnitOfWork } from '../ports/repositories';
import { toResult, type WagerTransactionResult } from '../wagering/process-wager-transaction';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

const toView = (w: Wallet): WalletView => ({ id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version });

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Wallet + transação OPENING + lançamento de crédito + evento na MESMA transação SQL.
   * Unicidade player+moeda garantida pela constraint wallets_player_currency_uq.
   */
  async execute(input: { playerId: string; initialBalance: MoneyProps }, correlationId: string): Promise<WalletView> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(input.initialBalance);
    } catch (error) {
      if (error instanceof DomainError) throw new ValidationError(error.message, [error.code]);
      throw error;
    }

    const at = this.clock.now();
    const walletId = newId(at.getTime());
    const opening = WagerTransaction.opening({ walletId, playerId: input.playerId, money: initialBalance, at });
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId: opening.id,
      at,
    });

    try {
      await this.uow.run(async (repos) => {
        await repos.wallets.insert(wallet);
        if (openingEntry) {
          await repos.transactions.insert(opening, correlationId);
          await repos.ledger.append(openingEntry, wallet.version);
          await repos.outbox.add([OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, { correlationId, at }))]);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError(input.playerId, initialBalance.currency);
      }
      throw error;
    }
    return toView(wallet);
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const c = current as { code?: string; constraint?: string; cause?: unknown };
    if (c.code === '23505' && c.constraint === constraint) return true;
    current = c.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------- consultas

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError('Wallet', walletId);
    return toView(wallet);
  }

  /**
   * Cursor opaco = base64url da última `seq` (identity monotônica) retornada.
   * Estável sob inserções concorrentes: novas entradas sempre têm seq maior.
   */
  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSeq = cursor === undefined ? undefined : decodeCursor(cursor);
    const page = await this.uow.read(async (r) => {
      const wallet = await r.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError('Wallet', walletId);
      return r.ledger.page(walletId, afterSeq, limit);
    });
    return {
      items: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.hasMore && page.lastSeq !== undefined ? encodeCursor(page.lastSeq) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<WagerTransactionResult & { kind: string; providerId: string; externalTransactionId: string }> {
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError('Transaction', transactionId);
    return { ...toResult(tx, false), kind: tx.kind, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId };
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string) {
    const tx = await this.uow.read((r) => r.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError('Transaction', `${providerId}/${externalTransactionId}`);
    return { ...toResult(tx, false), kind: tx.kind, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId };
  }
}

export function encodeCursor(seq: bigint): string {
  return Buffer.from(`v1:${seq}`).toString('base64url');
}

export function decodeCursor(cursor: string): bigint {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (!match) throw new ValidationError('Invalid cursor');
  return BigInt(match[1]!);
}

// ---------------------------------------------------------------------------- reconciliação

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly onMismatch: (view: ReconciliationView) => void,
  ) {}

  /**
   * Compara saldo materializado com o saldo reconstruído pelo ledger.
   * Executa sob lock da wallet para obter uma fotografia consistente.
   * Divergências NÃO são corrigidas: são logadas, contabilizadas e sinalizadas.
   */
  async execute(walletId: string): Promise<ReconciliationView> {
    const view = await this.uow.run(async (r) => {
      const wallet = await r.wallets.lockById(walletId);
      if (!wallet) throw new NotFoundError('Wallet', walletId);
      const replay = await r.ledger.replayBalance(walletId, wallet.currency);
      const difference = wallet.balance.subtract(replay.balance);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: replay.balance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: replay.entries,
      };
    });
    if (!view.consistent) {
      this.metrics.reconciliationMismatch();
      this.onMismatch(view);
    }
    return view;
  }
}

