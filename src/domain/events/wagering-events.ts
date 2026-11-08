import type { MoneyProps } from '../shared/money';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction, WagerTransactionKind } from '../wagering/wager-transaction';
import type { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { IntegrationEvent, type EventContext } from './integration-event';

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId?: string;
  balance: MoneyProps;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.baseProps(
        tx.id,
        {
          ...transactionRef(tx),
          ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
          balance: tx.resultingBalance!.toJSON(),
        },
        ctx,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
  balance?: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.baseProps(
        tx.id,
        {
          ...transactionRef(tx),
          failureCode: tx.failureCode!,
          ...(tx.resultingBalance ? { balance: tx.resultingBalance.toJSON() } : {}),
        },
        ctx,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempt: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.baseProps(
        tx.id,
        {
          ...transactionRef(tx),
          referenceExternalTransactionId: tx.referenceExternalTransactionId!,
          attempt: tx.referenceAttempts,
          nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. `walletVersion` permite ao consumidor ordenar/deduplicar. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.baseProps(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}
