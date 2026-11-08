import { z } from 'zod';

/**
 * Contratos de entrada. Validam FORMA (tipos, tamanhos, formato de UUID e de
 * decimal). Regras de negócio ficam no domínio. `amount` é sempre string:
 * um JSON number é rejeitado aqui, antes de qualquer conversão.
 */
const identifier = z.string().trim().min(1).max(128);
const uuid = z.uuid();

export const moneySchema = z.strictObject({
  amount: z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/, 'amount must be a non-negative decimal string with up to 2 decimals'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code'),
});

export const createWalletSchema = z.strictObject({
  playerId: uuid,
  initialBalance: moneySchema,
});

export const wagerTransactionSchema = z.strictObject({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: uuid,
  walletId: uuid,
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: identifier.optional(),
});

export const idempotencyKeySchema = z.string().trim().min(1).max(256).regex(/^[\x21-\x7E]+$/, 'printable ASCII without spaces');

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type WagerTransactionBody = z.infer<typeof wagerTransactionSchema>;
