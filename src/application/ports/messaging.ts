import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Publica eventos de integração no broker. Cada mensagem tem resultado próprio. */
export interface EventPublisher {
  publish(messages: OutboxMessage[]): Promise<Map<string, { ok: true } | { ok: false; error: string }>>;
}

/**
 * Armazenamento da outbox para o relay. Operações fora da transação de
 * negócio: o evento já está commitado quando o relay o enxerga.
 */
export interface OutboxStore {
  /**
   * Reivindica até `limit` mensagens devidas com lease exclusivo
   * (UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)).
   * Publishers concorrentes nunca recebem a mesma mensagem enquanto o lease vale;
   * se o processo morrer, o lease expira e outra instância assume.
   */
  claim(owner: string, limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]>;
  /**
   * Grava o resultado do ciclo (publicadas ou reagendadas) e libera o lease.
   * As publicadas são marcadas num único statement.
   */
  releaseBatch(owner: string, messages: OutboxMessage[]): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
export const OUTBOX_STORE = Symbol('OutboxStore');
