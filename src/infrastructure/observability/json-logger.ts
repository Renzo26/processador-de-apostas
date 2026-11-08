import type { LoggerService } from '@nestjs/common';
import { logContext } from './log-context';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Chaves que nunca devem ir para log, mesmo se passadas por engano. */
const REDACTED_KEYS = new Set(['authorization', 'password', 'token', 'secret', 'payload', 'body', 'money', 'balance']);

/**
 * Logger estruturado (uma linha JSON por evento) que injeta automaticamente
 * correlationId/messageId/transactionId/walletId/providerId do contexto
 * assíncrono corrente. Implementa LoggerService para substituir o logger do Nest.
 */
export class JsonLogger implements LoggerService {
  private readonly minLevel: number;

  constructor(
    level: Level = (process.env.LOG_LEVEL as Level) ?? 'info',
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  ) {
    this.minLevel = LEVELS[level] ?? LEVELS.info;
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  /** API estruturada preferida no código da aplicação. */
  info(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('info', event, [fields]);
  }

  private emit(level: Level, message: unknown, rest: unknown[]): void {
    if (LEVELS[level] < this.minLevel) return;

    // Convenção do Nest: último argumento string é o "context".
    const args = [...rest];
    const context = typeof args.at(-1) === 'string' ? (args.pop() as string) : undefined;
    const fields: Record<string, unknown> = {};
    for (const arg of args) {
      if (arg instanceof Error) fields.error = serializeError(arg);
      else if (arg && typeof arg === 'object') Object.assign(fields, sanitize(arg as Record<string, unknown>));
      else if (typeof arg === 'string' && level === 'error') fields.stack = arg;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      msg: message instanceof Error ? message.message : String(message),
      ...logContext.get(),
      ...fields,
      ...(message instanceof Error ? { error: serializeError(message) } : {}),
    };
    this.write(JSON.stringify(entry));
  }
}

function sanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

function serializeError(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(code !== undefined ? { code } : {}), stack: error.stack };
}

export const appLogger = new JsonLogger();
