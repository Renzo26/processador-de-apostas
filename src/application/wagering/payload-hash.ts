import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../domain/shared/money';
import { Money } from '../../domain/shared/money';

/** Subconjunto de campos de negócio que identifica o conteúdo da operação. */
export interface HashablePayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico do subconjunto de negócio.
 *
 * JSON canônico:
 *  - apenas os campos de `HashablePayload` (header Idempotency-Key, messageId,
 *    occurredAt e demais metadados de transporte ficam de fora);
 *  - chaves ordenadas lexicograficamente, recursivamente;
 *  - campos `undefined` omitidos;
 *  - `money.amount` normalizado para escala 2 ("25" e "25.00" são o mesmo valor);
 *  - sem espaços (JSON.stringify padrão), UTF-8.
 */
export function computePayloadHash(payload: HashablePayload): string {
  const normalized: HashablePayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
