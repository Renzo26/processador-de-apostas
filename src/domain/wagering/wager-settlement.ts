import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { LedgerDirection } from '../wallet/ledger-direction';
import { FailureCode } from './failure-code';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

/** Resultado da busca da referência por (providerId, referenceExternalTransactionId). */
export type ReferenceLookup =
  | { found: false }
  | {
      found: true;
      transaction: WagerTransaction;
      /** Já existe REFUND ou ROLLBACK PROCESSED apontando para ela. */
      alreadyReversed: boolean;
    };

export interface SettlementInput {
  transaction: WagerTransaction;
  /** undefined quando a wallet não existe. Deve estar LOCKADA pelo chamador. */
  wallet: Wallet | undefined;
  /** Obrigatório quando a transação traz referência. */
  reference?: ReferenceLookup;
  at: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference; nextAttemptAt: Date };

/** Que kinds cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Serviço de domínio que decide e aplica o efeito de uma WagerTransaction
 * sobre a Wallet. Puro: sem I/O. Muta os aggregates recebidos (transação e
 * wallet) e devolve o lançamento a ser persistido.
 *
 * Pré-condição: o chamador detém o lock da wallet, garantindo que a decisão
 * de saldo e de "já revertida" não sofre corrida.
 */
export class WagerSettlement {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy) {}

  settle(input: SettlementInput): SettlementOutcome {
    const { transaction: tx, wallet, at } = input;

    if (!wallet) return this.reject(tx, FailureCode.WalletNotFound, undefined, at);
    if (wallet.playerId !== tx.playerId) return this.reject(tx, FailureCode.WalletPlayerMismatch, wallet, at);
    if (wallet.currency !== tx.money.currency) return this.reject(tx, FailureCode.CurrencyMismatch, wallet, at);

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      const lookup = input.reference;
      if (!lookup) throw new Error('Reference lookup is required for transactions with reference');

      // Referência ausente ou ainda não decidida: aguardar (com limite).
      if (!lookup.found || !lookup.transaction.isTerminal()) {
        return this.awaitReference(tx, wallet, at);
      }

      const failure = this.validateReference(tx, lookup.transaction, lookup.alreadyReversed);
      if (failure) return this.reject(tx, failure, wallet, at);
      reference = lookup.transaction;
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, wallet.balance, at);
      return { status: WagerTransactionStatus.Processed, entry: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return this.reject(tx, code, wallet, at);
    }

    const entry = wallet.move(direction, { money: tx.money, transactionId: tx.id, at });
    tx.markProcessed(reference?.id, wallet.balance, at);
    return { status: WagerTransactionStatus.Processed, entry };
  }

  /** Referência ausente: agenda nova tentativa com backoff ou rejeita ao esgotar o limite. */
  private awaitReference(tx: WagerTransaction, wallet: Wallet, at: Date): SettlementOutcome {
    if (this.retryPolicy.isExhausted(tx.referenceAttempts)) {
      return this.reject(tx, FailureCode.ReferenceNotFound, wallet, at);
    }
    const nextAttemptAt = this.retryPolicy.nextAttemptAt(tx.referenceAttempts, at);
    tx.markPendingReference(nextAttemptAt);
    return { status: WagerTransactionStatus.PendingReference, nextAttemptAt };
  }

  private validateReference(tx: WagerTransaction, ref: WagerTransaction, alreadyReversed: boolean): FailureCode | undefined {
    const sameContext =
      ref.providerId === tx.providerId &&
      ref.playerId === tx.playerId &&
      ref.walletId === tx.walletId &&
      ref.roundId === tx.roundId &&
      ref.money.currency === tx.money.currency;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    if (!ALLOWED_REFERENCE_KINDS[tx.kind]?.includes(ref.kind)) return FailureCode.ReferenceKindNotAllowed;

    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    if (tx.isReversal()) {
      if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
      if (!ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
    }
    return undefined;
  }

  private reject(tx: WagerTransaction, code: FailureCode, wallet: Wallet | undefined, at: Date): SettlementOutcome {
    tx.reject(code, wallet?.balance, at);
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  }
}
