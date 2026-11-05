import { newId } from '../shared/id';
import type { Money } from '../shared/money';
import { LedgerDirection, oppositeDirection } from '../wallet/ledger-direction';
import type { FailureCode } from './failure-code';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wager-transaction.errors';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds que podem ser submetidos pela API ou pela fila. */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas:
 *
 *   PENDING ──────────┬──> PROCESSED
 *      │              ├──> REJECTED
 *      │              └──> FAILED
 *      └──> PENDING_REFERENCE ──(reprocesso)──> PROCESSED | REJECTED | FAILED
 *                 └──(ainda sem referência)──> PENDING_REFERENCE
 *
 * PROCESSED, REJECTED e FAILED são terminais.
 */
const ALLOWED: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

const MAX_ID_LENGTH = 128;

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  id: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Saldo observado no momento da decisão — devolvido em replays. */
  resultingBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultingBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Valida o payload e a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(`Kind "${props.kind}" cannot be submitted externally`);
    }
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      assertIdentifier(field, props[field]);
    }
    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('payloadHash must be a SHA-256 hex digest');
    }

    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.referenceExternalTransactionId !== undefined) {
      assertIdentifier('referenceExternalTransactionId', props.referenceExternalTransactionId);
      if (props.referenceExternalTransactionId === props.externalTransactionId) {
        throw new InvalidWagerTransactionError('A transaction cannot reference itself');
      }
    }

    // LOSS registra resultado sem mover saldo: aceita zero. Os demais movimentam saldo: exigem valor positivo.
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        props.kind === WagerTransactionKind.Loss ? 'LOSS amount cannot be negative' : `${props.kind} amount must be positive`,
      );
    }

    return new WagerTransaction(
      newId(props.createdAt.getTime()),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /**
   * Transação interna de abertura de wallet — já nasce PROCESSED, na mesma
   * transação SQL que cria a wallet e o lançamento de crédito.
   */
  static opening(props: { walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const id = newId(props.at.getTime());
    return new WagerTransaction(
      id,
      'internal',
      `opening:${props.walletId}`,
      `internal:opening:${props.walletId}`,
      '0'.repeat(64),
      props.walletId,
      props.playerId,
      'opening',
      'opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(props.at),
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      new Date(props.at),
      props.money,
      0,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt && new Date(state.processedAt),
      state.resultingBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt && new Date(state.nextReferenceAttemptAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, balance: Money, at: Date): void {
    this.transition(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = balance;
    this._processedAt = new Date(at);
    this._nextReferenceAttemptAt = undefined;
  }

  /** Agenda nova tentativa de resolver a referência (backoff calculado pela policy). */
  markPendingReference(nextAttemptAt: Date): void {
    this.transition(WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = new Date(nextAttemptAt);
  }

  reject(code: FailureCode, balance: Money | undefined, at: Date): void {
    this.transition(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._resultingBalance = balance;
    this._processedAt = new Date(at);
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transition(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = new Date(at);
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento gerado por esta transação.
   * ROLLBACK inverte a direção da transação referenciada.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK direction requires the referenced transaction');
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not produce ledger entries');
    }
  }

  private transition(to: WagerTransactionStatus): void {
    if (!ALLOWED[this._status].includes(to)) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
    this._status = to;
  }
}

function assertIdentifier(field: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    throw new InvalidWagerTransactionError(`${field} must be a non-empty string up to ${MAX_ID_LENGTH} chars`);
  }
}
