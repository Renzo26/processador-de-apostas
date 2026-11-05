import { DomainError } from '../shared/domain-error';
import type { Money } from '../shared/money';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Wallet ${walletId} has insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançamento aritmeticamente inconsistente. Indica bug, não regra de negócio:
 * nunca deveria ser alcançado por entrada externa.
 */
export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}
