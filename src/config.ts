import { z } from 'zod';

/** Flag booleana vinda de variável de ambiente ("true"/"false"/"1"/"0"). */
const flag = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1'));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  INSTANCE_ID: z.string().default(`instance-${process.pid}`),

  DATABASE_URL: z.string().default('postgresql://wagering:wagering@localhost:55432/wagering'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RUN_MIGRATIONS: flag(false),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_ENDPOINT: z.string().default('http://localhost:4566'),
  SQS_QUEUE_NAME: z.string().default('wager-transactions.fifo'),
  SQS_DLQ_NAME: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().default('wallet-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  SQS_VISIBILITY_TIMEOUT_S: z.coerce.number().int().positive().default(30),
  SQS_CONSUMER_ENABLED: flag(true),
  SQS_CONSUMER_CONCURRENCY: z.coerce.number().int().positive().default(10),

  OUTBOX_PUBLISHER_ENABLED: flag(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(30_000),

  PENDING_REFERENCE_WORKER_ENABLED: flag(true),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  REFERENCE_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  REFERENCE_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),

  /** Somente para testes de resiliência. Nunca definir em produção. */
  FAULT_INJECTION: z.enum(['crash-before-ack']).optional(),

  AUTH_ENABLED: flag(false),
  AUTH_ISSUER: z.string().optional(),
  AUTH_JWKS_URI: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('AppConfig');
