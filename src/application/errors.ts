/**
 * Erros da camada de aplicação. Cada classe corresponde a UMA categoria que o
 * cliente precisa distinguir para decidir se reenvia (ver mapeamento HTTP).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. Não é replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code: string;

  constructor(reason: 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_ID_REUSED' | 'INBOX_MESSAGE_ID_REUSED') {
    super(
      reason === 'IDEMPOTENCY_KEY_REUSED'
        ? 'Idempotency-Key was already used with a different payload'
        : reason === 'EXTERNAL_TRANSACTION_ID_REUSED'
          ? 'externalTransactionId was already used with a different idempotency key or payload'
          : 'messageId was already used with a different payload',
    );
    this.code = reason;
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} in ${currency} already exists`);
  }
}

export class NotFoundError extends ApplicationError {
  readonly code: string;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.code = `${resource.toUpperCase()}_NOT_FOUND`;
  }
}

export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Corrida detectada pelo banco (unique violation em chave de idempotência,
 * versão de wallet já usada). A operação é reexecutada internamente: na nova
 * tentativa, o vencedor já está commitado e o fluxo cai no replay.
 */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(
    readonly constraint: string,
    cause?: unknown,
  ) {
    super(`Concurrent write conflict on ${constraint}`, { cause });
  }
}

/** Falha transitória (banco indisponível, lock timeout, conflito de serialização). Reenviar é seguro. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
