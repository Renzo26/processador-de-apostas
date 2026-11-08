import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** O cliente pode reenviar a MESMA requisição (mesma Idempotency-Key)? */
    retryable: boolean;
    details?: string[];
  };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

/**
 * Mapeamento ÚNICO de erros para HTTP, usado por todos os endpoints.
 *
 *   400 VALIDATION_ERROR            payload inválido — corrigir antes de reenviar
 *   401/403                         autenticação/autorização
 *   404 *_NOT_FOUND                 recurso inexistente
 *   409 IDEMPOTENCY_KEY_REUSED etc. conflito de idempotência — NÃO é replay
 *   409 WALLET_ALREADY_EXISTS       conflito de unicidade
 *   422 (corpo da transação)        rejeição por regra de negócio (failureCode) — definitiva
 *   202 (corpo da transação)        aceita, processamento pendente
 *   503 TRANSIENT_FAILURE           infraestrutura indisponível — reenviar com a mesma key
 *   500 INTERNAL_ERROR              erro inesperado
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof ZodError) {
    return fail(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Invalid request', false, error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  if (error instanceof ValidationError) {
    return fail(HttpStatus.BAD_REQUEST, error.code, error.message, false, error.details);
  }
  if (error instanceof DomainError) {
    return fail(HttpStatus.BAD_REQUEST, error.code, error.message, false);
  }
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
    return fail(HttpStatus.CONFLICT, error.code, error.message, false);
  }
  if (error instanceof NotFoundError) {
    return fail(HttpStatus.NOT_FOUND, error.code, error.message, false);
  }
  if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError) {
    return { ...fail(HttpStatus.SERVICE_UNAVAILABLE, 'TRANSIENT_FAILURE', 'Temporary failure, retry with the same Idempotency-Key', true), retryAfterSeconds: 1 };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
    return fail(status, code, error.message, status >= 500);
  }
  return fail(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Unexpected error', true);
}

function fail(status: number, code: string, message: string, retryable: boolean, details?: string[]): MappedError {
  return { status, body: { error: { code, message, retryable, ...(details?.length ? { details } : {}) } } };
}
