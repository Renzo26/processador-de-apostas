/**
 * Taxonomia estável de falhas, legível por máquina.
 *
 * Cada código diz ao provedor o que fazer:
 *  - FIX_PAYLOAD: o pedido nunca vai passar como está; corrigir e reenviar com NOVA idempotency key.
 *  - FINAL: decisão de negócio definitiva; não reenviar.
 *  - RETRY: falha de infraestrutura; reenviar com a MESMA idempotency key é seguro.
 */
export enum FailureCode {
  // ---- regras de saldo (FINAL)
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK de crédito (WIN/REFUND) que deixaria o saldo negativo — operacionalmente distinto de aposta sem saldo. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // ---- vínculo com a wallet (FIX_PAYLOAD)
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  // ---- referências (FINAL)
  /** Referência não apareceu dentro da janela de reprocessamento. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas pertence a outro player/wallet/rodada/moeda. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido (ex.: REFUND de WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência terminou REJECTED/FAILED — não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência já foi revertida (por REFUND ou ROLLBACK). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',

  // ---- infraestrutura (estado FAILED, auditável)
  /** Erro permanente de processamento (ex.: mensagem esgotou tentativas). */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export type FailureAction = 'FINAL' | 'FIX_PAYLOAD' | 'RETRY';

export const FAILURE_ACTION: Readonly<Record<FailureCode, FailureAction>> = {
  [FailureCode.InsufficientFunds]: 'FINAL',
  [FailureCode.ReversalInsufficientFunds]: 'FINAL',
  [FailureCode.WalletNotFound]: 'FIX_PAYLOAD',
  [FailureCode.WalletPlayerMismatch]: 'FIX_PAYLOAD',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotFound]: 'FINAL',
  [FailureCode.ReferenceMismatch]: 'FINAL',
  [FailureCode.ReferenceKindNotAllowed]: 'FINAL',
  [FailureCode.ReferenceNotProcessed]: 'FINAL',
  [FailureCode.ReferenceAlreadyReversed]: 'FINAL',
  [FailureCode.ReferenceAmountMismatch]: 'FINAL',
  [FailureCode.ProcessingFailed]: 'RETRY',
};
