import { z } from 'zod';
import { idempotencyKeySchema, wagerTransactionSchema } from '../http/schemas';

/** Envelope da fila wager-transactions.fifo. Mesmo contrato de negócio do HTTP. */
export const wagerMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  correlationId: z.string().max(128).optional(),
  data: wagerTransactionSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
