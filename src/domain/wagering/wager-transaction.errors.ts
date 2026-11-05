import { DomainError } from '../shared/domain-error';
import type { WagerTransactionStatus } from './wager-transaction';

/** Payload estruturalmente inválido (nunca vira transação persistida). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Tentativa de transição a partir de estado terminal (ou transição inválida).
 * É erro de programação, não caminho de negócio — por isso não é DomainError.
 */
export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Invalid transition for transaction ${transactionId}: ${from} -> ${to}`);
    this.name = 'InvalidTransactionStateError';
  }
}
