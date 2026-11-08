import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação permitidos nos logs (nunca payload financeiro completo). */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const logContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...ctx }, fn);
  },
  /** Acrescenta campos ao contexto corrente (ex.: transactionId depois de criada). */
  assign(ctx: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, ctx);
  },
  get(): LogContext {
    return storage.getStore() ?? {};
  },
};
